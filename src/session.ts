import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { closeSync, openSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import koffi from "koffi";

export type StoredSession = {
  refresh_token: string;
  access_token: string;
  expires_at: string;
};

type CredentialMap = Record<string, StoredSession>;

// Go locks one byte at offset 0 on a non-overlapped handle (LOCKFILE_EXCLUSIVE_LOCK).
// Node file handles are overlapped, so this opens the lock file itself.
const LOCKFILE_EXCLUSIVE_LOCK = 0x2;
const INVALID_HANDLE = (1n << 64n) - 1n;

type HeldLock =
  | { kind: "win"; handle: bigint; overlapped: Buffer }
  | { kind: "unix"; fd: number; flock: (fd: number, op: number) => number };

let winLock: {
  create: (
    name: string,
    access: number,
    share: number,
    sec: null,
    disp: number,
    flags: number,
    tmpl: null
  ) => bigint;
  lock: (
    handle: bigint,
    flags: number,
    reserved: number,
    low: number,
    high: number,
    overlapped: Buffer
  ) => boolean;
  unlock: (
    handle: bigint,
    reserved: number,
    low: number,
    high: number,
    overlapped: Buffer
  ) => boolean;
  close: (handle: bigint) => boolean;
} | null = null;

let unixFlock: ((fd: number, op: number) => number) | null = null;

function winApi() {
  if (winLock) return winLock;
  const lib = koffi.load("kernel32.dll");
  winLock = {
    create: lib.func(
      "void* __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void* sec, uint32 disp, uint32 flags, void* tmpl)"
    ),
    lock: lib.func(
      "bool __stdcall LockFileEx(void* h, uint32 flags, uint32 reserved, uint32 low, uint32 high, void* ol)"
    ),
    unlock: lib.func(
      "bool __stdcall UnlockFileEx(void* h, uint32 reserved, uint32 low, uint32 high, void* ol)"
    ),
    close: lib.func("bool __stdcall CloseHandle(void* h)"),
  };
  return winLock;
}

function unixApi(): (fd: number, op: number) => number {
  if (unixFlock) return unixFlock;
  const name = process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6";
  unixFlock = koffi.load(name).func("int flock(int fd, int op)");
  return unixFlock;
}

export function credentialFile(configHome: string): string {
  return path.join(configHome, "consail", "credentials.json");
}

function acquire(configHome: string): HeldLock {
  const file = credentialFile(configHome);
  mkdirSync(path.dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  if (process.platform === "win32") {
    const api = winApi();
    const handle = api.create(lockPath, 0xc0000000, 0x3, null, 4, 0x80, null);
    if (handle === 0n || handle === -1n || handle === INVALID_HANDLE) {
      throw new Error("credential lock failed");
    }
    const overlapped = Buffer.alloc(32);
    if (!api.lock(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped)) {
      api.close(handle);
      throw new Error("credential lock failed");
    }
    return { kind: "win", handle, overlapped };
  }
  const fd = openSync(lockPath, "a+");
  const flock = unixApi();
  if (flock(fd, 2) !== 0) {
    closeSync(fd);
    throw new Error("credential lock failed");
  }
  return { kind: "unix", fd, flock };
}

function release(lock: HeldLock): void {
  if (lock.kind === "win") {
    const api = winApi();
    api.unlock(lock.handle, 0, 1, 0, lock.overlapped);
    api.close(lock.handle);
    return;
  }
  lock.flock(lock.fd, 8);
  closeSync(lock.fd);
}

export async function withCredentialLock<T>(
  configHome: string,
  fn: () => Promise<T>
): Promise<T> {
  const lock = acquire(configHome);
  try {
    return await fn();
  } finally {
    release(lock);
  }
}

function readMap(configHome: string): CredentialMap {
  const file = credentialFile(configHome);
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  if (buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString("utf8")) as CredentialMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    throw new Error("credential file is corrupt");
  }
}

let userSid = "";

// The CLI gives credentials.json a protected, user-only DACL; chmod 0600 is not a DACL. A renamed
// temp file would carry the folder's inherited ACL, so the temp file gets the same single ACE
// before any token is written into it. Fails closed.
function tightenWindowsACL(file: string): void {
  const sys32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
  if (!userSid) {
    const out = execFileSync(path.join(sys32, "whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
    });
    const sid = out.trim().split(",").pop()?.replace(/"/g, "") ?? "";
    if (!sid.startsWith("S-1-")) throw new Error("credential file: cannot resolve the current user SID");
    userSid = sid;
  }
  execFileSync(path.join(sys32, "icacls.exe"), [file, "/inheritance:r", "/grant:r", `*${userSid}:F`], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function writeMap(configHome: string, entries: CredentialMap): void {
  const file = credentialFile(configHome);
  const tmp = path.join(path.dirname(file), `.credentials-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, "", { mode: 0o600 });
    if (process.platform === "win32") tightenWindowsACL(tmp);
    writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

export function peekSession(configHome: string, baseUrl: string): StoredSession | null {
  const lock = acquire(configHome);
  try {
    const row = readMap(configHome)[baseUrl];
    if (!row?.access_token) return null;
    return row;
  } finally {
    release(lock);
  }
}

export function needsRefresh(session: StoredSession): boolean {
  if (!session.access_token) return true;
  const exp = Date.parse(session.expires_at);
  if (Number.isNaN(exp)) return true;
  return Date.now() + 60_000 >= exp;
}

// refresh runs while the credential file lock is held.
export async function loadFreshSession(
  configHome: string,
  baseUrl: string,
  force: boolean,
  refresh: (current: StoredSession) => Promise<StoredSession | "ended">
): Promise<StoredSession | null> {
  return withCredentialLock(configHome, async () => {
    const entries = readMap(configHome);
    const current = entries[baseUrl];
    if (!current?.access_token || !current.refresh_token) return null;
    if (!force && !needsRefresh(current)) return current;
    const next = await refresh(current);
    if (next === "ended") {
      delete entries[baseUrl];
      writeMap(configHome, entries);
      return null;
    }
    entries[baseUrl] = next;
    writeMap(configHome, entries);
    return next;
  });
}

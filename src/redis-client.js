// A minimal Redis client: one connection, RESP2, the handful of commands the
// refresh store uses (AUTH, PING, GET, SET, GETDEL, DEL, EXPIRE). No scripting
// and no transactions, so it works under an ACL that grants only read, write and
// keyspace commands. Commands are pipelined on the single connection and their
// replies matched in order. A broken connection fails the commands in flight and
// is re-opened on the next command.
//
// URL: redis://[user[:password]@]host[:port][/db]. A password given separately
// (MCP_REDIS_PASSWORD, from a Secret) takes precedence over one in the URL.

import net from "node:net";

export class RedisError extends Error {}

function encode(args) {
  let out = `*${args.length}\r\n`;
  for (const a of args) {
    const s = String(a);
    out += `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
  }
  return out;
}

// Parses one reply from buf at offset; returns [value, nextOffset] or null when
// the reply is not complete yet.
function parse(buf, off) {
  if (off >= buf.length) return null;
  const type = String.fromCharCode(buf[off]);
  const eol = buf.indexOf("\r\n", off);
  if (eol < 0) return null;
  const line = buf.toString("utf8", off + 1, eol);
  const next = eol + 2;
  if (type === "+") return [line, next];
  if (type === "-") return [new RedisError(line), next];
  if (type === ":") return [Number(line), next];
  if (type === "$") {
    const len = Number(line);
    if (len < 0) return [null, next];
    if (buf.length < next + len + 2) return null;
    return [buf.toString("utf8", next, next + len), next + len + 2];
  }
  if (type === "*") {
    const n = Number(line);
    if (n < 0) return [null, next];
    const items = [];
    let o = next;
    for (let i = 0; i < n; i++) {
      const r = parse(buf, o);
      if (!r) return null;
      items.push(r[0]);
      o = r[1];
    }
    return [items, o];
  }
  throw new RedisError(`unexpected reply type ${JSON.stringify(type)}`);
}

export function createRedisClient({ url, password, timeoutMs = 2000 } = {}) {
  const u = new URL(url);
  if (u.protocol !== "redis:") throw new Error("only redis:// URLs are supported");
  const host = u.hostname;
  const port = Number(u.port || 6379);
  const username = decodeURIComponent(u.username || "");
  const pass = password ?? (u.password ? decodeURIComponent(u.password) : "");
  const db = Number(u.pathname.replace(/^\//, "") || 0);

  let socket = null;
  let ready = null; // Promise resolved once the connection is authenticated
  let pending = []; // { resolve, reject, timer }
  let buffer = Buffer.alloc(0);

  function failAll(err) {
    const p = pending;
    pending = [];
    for (const w of p) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  function drop(err) {
    if (socket) socket.destroy();
    socket = null;
    ready = null;
    buffer = Buffer.alloc(0);
    failAll(err);
  }

  function send(args) {
    return new Promise((resolve, reject) => {
      const w = { resolve, reject, timer: null };
      w.timer = setTimeout(() => drop(new RedisError("redis command timed out")), timeoutMs);
      pending.push(w);
      socket.write(encode(args));
    });
  }

  function connect() {
    if (ready) return ready;
    ready = new Promise((resolve, reject) => {
      const s = net.createConnection({ host, port });
      socket = s;
      s.setNoDelay(true);
      const t = setTimeout(() => {
        reject(new RedisError("redis connect timed out"));
        drop(new RedisError("redis connect timed out"));
      }, timeoutMs);
      s.on("data", (chunk) => {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        let off = 0;
        for (;;) {
          let r;
          try {
            r = parse(buffer, off);
          } catch (err) {
            drop(err);
            return;
          }
          if (!r) break;
          off = r[1];
          const w = pending.shift();
          if (!w) continue;
          clearTimeout(w.timer);
          if (r[0] instanceof RedisError) w.reject(r[0]);
          else w.resolve(r[0]);
        }
        buffer = buffer.subarray(off);
      });
      s.on("error", (err) => {
        clearTimeout(t);
        reject(err);
        drop(err);
      });
      s.on("close", () => {
        if (socket === s) drop(new RedisError("redis connection closed"));
      });
      s.on("connect", async () => {
        clearTimeout(t);
        try {
          if (pass) await send(username ? ["AUTH", username, pass] : ["AUTH", pass]);
          if (db) await send(["SELECT", db]);
          resolve();
        } catch (err) {
          reject(err);
          drop(err);
        }
      });
    });
    // A failed connect is retried on the next command.
    ready.catch(() => {});
    return ready;
  }

  async function command(...args) {
    await connect();
    return send(args);
  }

  return {
    command,
    get: (k) => command("GET", k),
    set: (k, v, ttlSeconds) => command("SET", k, v, "EX", Math.max(1, Math.ceil(ttlSeconds))),
    getdel: (k) => command("GETDEL", k),
    del: (...keys) => command("DEL", ...keys),
    expire: (k, ttlSeconds) => command("EXPIRE", k, Math.max(1, Math.ceil(ttlSeconds))),
    ping: () => command("PING"),
    close() {
      drop(new RedisError("redis client closed"));
    },
  };
}

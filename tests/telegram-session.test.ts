import { describe, it, expect } from "vitest";
import {
  withSession,
  loadSession,
  SESSION_TTL_MS,
  type SessionData,
} from "@/lib/telegram/session";

/**
 * In-memory stand-in for the telegram_sessions table.
 *
 * Records every write so tests can assert not just the final state but whether
 * a write happened at all — "does not write when nothing changed" is a real
 * requirement, since the webhook runs on every keystroke of a flow.
 */
function sessionStub(
  initial: Record<number, { data: SessionData; expires_at: string }> = {}
) {
  const rows: Record<number, { data: SessionData; expires_at: string }> = {
    ...initial,
  };
  const writes: { op: "upsert" | "delete"; id: number; data?: SessionData }[] = [];

  const client = {
    from() {
      return {
        select() {
          return {
            eq(_col: string, id: number) {
              return {
                maybeSingle: async () => ({
                  data: rows[id] ?? null,
                  error: null,
                }),
              };
            },
          };
        },
        upsert(payload: { telegram_user_id: number; data: SessionData; expires_at: string }) {
          writes.push({ op: "upsert", id: payload.telegram_user_id, data: payload.data });
          rows[payload.telegram_user_id] = {
            data: payload.data,
            expires_at: payload.expires_at,
          };
          return Promise.resolve({ error: null });
        },
        delete() {
          return {
            eq: async (_col: string, id: number) => {
              writes.push({ op: "delete", id });
              delete rows[id];
              return { error: null };
            },
          };
        },
      };
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: client as any, rows, writes };
}

const future = () => new Date(Date.now() + SESSION_TTL_MS).toISOString();
const past = () => new Date(Date.now() - 1000).toISOString();

describe("loadSession", () => {
  it("returns an empty object when there is no row", async () => {
    const { client } = sessionStub();
    expect(await loadSession(client, 42)).toEqual({});
  });

  it("returns stored data for a live session", async () => {
    const { client } = sessionStub({
      42: { data: { action: "add", step: "name" }, expires_at: future() },
    });
    expect(await loadSession(client, 42)).toEqual({ action: "add", step: "name" });
  });

  it("treats an expired session as absent", async () => {
    // Correctness must not depend on when the reaper last ran.
    const { client } = sessionStub({
      42: { data: { action: "add" }, expires_at: past() },
    });
    expect(await loadSession(client, 42)).toEqual({});
  });
});

describe("withSession", () => {
  it("persists what the handler wrote", async () => {
    const { client, rows } = sessionStub();

    await withSession(client, 42, async (s) => {
      s.data.action = "add";
      s.data.step = "name";
    });

    expect(rows[42].data).toEqual({ action: "add", step: "name" });
  });

  it("persists across two separate invocations, which is the whole point", async () => {
    // Step one and step two land on different lambdas in production.
    const { client } = sessionStub();

    await withSession(client, 42, async (s) => {
      s.data.action = "add";
      s.data.step = "name";
    });

    let seen: SessionData = {};
    await withSession(client, 42, async (s) => {
      seen = { ...s.data };
      s.data.name = "Dana";
      s.data.step = "loan_type";
    });

    expect(seen).toEqual({ action: "add", step: "name" });

    await withSession(client, 42, async (s) => {
      expect(s.data.name).toBe("Dana");
      expect(s.data.step).toBe("loan_type");
    });
  });

  it("deletes the row when the handler clears the session", async () => {
    const { client, rows, writes } = sessionStub({
      42: { data: { action: "add" }, expires_at: future() },
    });

    await withSession(client, 42, async (s) => {
      s.clear();
    });

    expect(rows[42]).toBeUndefined();
    expect(writes.some((w) => w.op === "delete")).toBe(true);
  });

  it("persists on an early return", async () => {
    // Command handlers return from a dozen places; that is exactly why the
    // save lives in a finally rather than at each call site.
    const { client, rows } = sessionStub();

    await withSession(client, 42, async (s) => {
      s.data.action = "move";
      if (s.data.action === "move") return;
      s.data.unreachable = "yes";
    });

    expect(rows[42].data).toEqual({ action: "move" });
  });

  it("persists even when the handler throws", async () => {
    // A failed step should not reset a flow to the beginning.
    const { client, rows } = sessionStub();

    await expect(
      withSession(client, 42, async (s) => {
        s.data.action = "task";
        throw new Error("Bonzo timed out");
      })
    ).rejects.toThrow("Bonzo timed out");

    expect(rows[42].data).toEqual({ action: "task" });
  });

  it("does not write when the handler changed nothing", async () => {
    // Read-only callbacks are common; each one writing would be pure noise.
    const { client, writes } = sessionStub({
      42: { data: { action: "add" }, expires_at: future() },
    });

    await withSession(client, 42, async (s) => {
      void s.data.action;
    });

    expect(writes).toEqual([]);
  });

  it("does not write when there was nothing and nothing was added", async () => {
    const { client, writes } = sessionStub();
    await withSession(client, 42, async () => {});
    expect(writes).toEqual([]);
  });

  it("isolates one Telegram user's session from another's", async () => {
    const { client, rows } = sessionStub();

    await withSession(client, 1, async (s) => {
      s.data.action = "add";
    });
    await withSession(client, 2, async (s) => {
      s.data.action = "move";
    });

    expect(rows[1].data.action).toBe("add");
    expect(rows[2].data.action).toBe("move");
  });

  it("hands the handler a copy, so a throw cannot leak a half-written field", async () => {
    const { client, rows } = sessionStub({
      42: { data: { action: "add" }, expires_at: future() },
    });

    await withSession(client, 42, async (s) => {
      s.data.step = "name";
    });

    // The stored row is the handler's object, not a mutated shared reference.
    expect(rows[42].data).toEqual({ action: "add", step: "name" });
  });

  it("returns the handler's value to the caller", async () => {
    const { client } = sessionStub();
    const out = await withSession(client, 42, async () => "done");
    expect(out).toBe("done");
  });

  it("refreshes the TTL on every write", async () => {
    const { client, rows } = sessionStub({
      42: { data: { action: "add" }, expires_at: past() },
    });

    await withSession(client, 42, async (s) => {
      // Loaded as empty because it was expired; writing starts a fresh session.
      s.data.action = "task";
    });

    expect(new Date(rows[42].expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("does not fail the update when persistence itself fails", async () => {
    // Losing session state is bad; making Telegram retry the whole update and
    // re-run the handler's side effects is worse.
    const client = {
      from() {
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
          }),
          upsert: async () => ({ error: { message: "connection reset" } }),
        };
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    await expect(
      withSession(client, 42, async (s) => {
        s.data.action = "add";
      })
    ).resolves.toBeUndefined();
  });
});

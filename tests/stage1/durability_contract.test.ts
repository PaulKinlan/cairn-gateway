import { assert, equals } from "../assert.ts";

interface Scenario {
  id: string;
  title: string;
}
interface WorkerInput {
  action: string;
  root: string;
  owner?: { tenantId: string; userId: string };
  id?: string;
  hash?: string;
  hashes?: string[];
  kind?: "nonce" | "jti";
  expiresAt?: number;
  now?: number;
  suffix?: string;
  enrollmentId?: string;
  subject?: "principal" | "agent" | "device" | "grant" | "connection";
  status?: "active" | "revoked";
  version?: number;
  custodyRef?: string;
  path?: string;
}
interface WorkerResult {
  code: number;
  outcome?: string;
  value?: unknown;
}
const scenarios = JSON.parse(
  await Deno.readTextFile("tests/stage1/fixtures/durability-scenarios.json"),
) as Scenario[];
const worker = new URL("./workers/authority_worker.ts", import.meta.url);
const alice = { tenantId: "tenant_a", userId: "user_a" };
const bob = { tenantId: "tenant_b", userId: "user_b" };

async function run(input: WorkerInput): Promise<WorkerResult> {
  const output = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--allow-read",
      "--allow-write",
      worker.pathname,
      JSON.stringify(input),
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(output.stdout).trim();
  if (!text) return { code: output.code };
  return { code: output.code, ...JSON.parse(text) };
}
const ok = async (input: WorkerInput): Promise<unknown> => {
  const result = await run(input);
  equals({ code: result.code, outcome: result.outcome }, { code: 0, outcome: "ok" });
  return result.value;
};
const inspect = async (root: string, owner = alice): Promise<Record<string, unknown>> =>
  await ok({ action: "inspect", root, owner }) as Record<string, unknown>;
const reserveWithAmbiguousReply = async (input: WorkerInput): Promise<unknown> => {
  const result = await run(input);
  return result.code === 0 ? result.value : "unknown_commit";
};
const tenantOf = (view: Record<string, unknown>): Record<string, unknown> =>
  view.tenant as Record<string, unknown>;
const setup = async (root: string, owner = alice, custodyRef?: string) => {
  equals(await ok({ action: "seed", root, owner, custodyRef }), true);
};

const cases: Record<string, (root: string) => Promise<void>> = {
  "DUR-01": async (root) => {
    await setup(root);
    const restarted = await inspect(root);
    equals(restarted.exists, true);
    equals(restarted.schemaVersion, 2);
  },
  "DUR-02": async (root) => {
    await setup(root);
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["isolation"],
        expiresAt: 90,
        now: 1,
      }),
      true,
    );
    const other = await inspect(root, bob);
    equals(other.exists, false);
  },
  "DUR-03": async (root) => {
    await setup(root);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ok({
          action: "consume",
          root,
          owner: alice,
          kind: "nonce",
          hashes: ["race"],
          expiresAt: 90,
          now: 1,
        })),
    );
    equals(results.filter(Boolean).length, 1);
  },
  "DUR-04": async (root) => {
    await setup(root);
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["first"],
        expiresAt: 90,
        now: 1,
      }),
      true,
    );
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["first", "second"],
        expiresAt: 90,
        now: 1,
      }),
      false,
    );
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["second"],
        expiresAt: 90,
        now: 1,
      }),
      true,
    );
  },
  "DUR-05": async (root) => {
    await setup(root);
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        ok({
          action: "consume",
          root,
          owner: alice,
          kind: "jti",
          hashes: ["capability"],
          expiresAt: 90,
          now: 1,
        })),
    );
    equals(results.filter(Boolean).length, 1);
  },
  "DUR-06": async (root) => {
    await setup(root);
    equals(await ok({ action: "reserve", root, owner: alice, id: "attempt", now: 10 }), "reserved");
    const tenant = tenantOf(await inspect(root));
    const replay = tenant.replay as Record<string, number>;
    const attempts = tenant.attempts as Record<string, Record<string, unknown>>;
    equals(Object.keys(replay).sort(), [
      "jti/jti_attempt",
      "nonce/agent_attempt",
      "nonce/device_attempt",
    ]);
    equals(attempts.attempt?.state, "reserved");
  },
  "DUR-07": async (root) => {
    await setup(root);
    await ok({ action: "reserve", root, owner: alice, id: "dispatch", now: 10 });
    const results = await Promise.all(
      Array.from(
        { length: 8 },
        () => ok({ action: "beginDispatch", root, owner: alice, id: "dispatch" }),
      ),
    );
    equals(results.filter((item) => item === "permit").length, 1);
  },
  "DUR-08": async (root) => {
    await setup(root);
    equals((await run({ action: "crashBefore", root, owner: alice, id: "before" })).code, 75);
    const tenant = tenantOf(await inspect(root));
    equals(Object.keys(tenant.attempts as object).length, 0);
    equals(Object.keys(tenant.replay as object).length, 0);
  },
  "DUR-09": async (root) => {
    await setup(root);
    equals(
      await reserveWithAmbiguousReply({
        action: "reserveExit",
        root,
        owner: alice,
        id: "ambiguous",
        now: 10,
      }),
      "unknown_commit",
    );
    const tenant = tenantOf(await inspect(root));
    equals(
      (tenant.attempts as Record<string, Record<string, unknown>>).ambiguous?.state,
      "reserved",
    );
    equals(
      await ok({ action: "reserve", root, owner: alice, id: "ambiguous", now: 10 }),
      "already_consumed",
    );
  },
  "DUR-10": async (root) => {
    await setup(root);
    await ok({ action: "reserve", root, owner: alice, id: "pre_dispatch", now: 10 });
    const attempt =
      (tenantOf(await inspect(root)).attempts as Record<string, Record<string, unknown>>)
        .pre_dispatch;
    equals(attempt?.state, "reserved");
    equals(attempt?.dispatchPermitUsed, false);
    equals(attempt?.automaticRetry, false);
  },
  "DUR-11": async (root) => {
    await setup(root);
    await ok({ action: "reserve", root, owner: alice, id: "during", now: 10 });
    equals((await run({ action: "dispatchExit", root, owner: alice, id: "during" })).code, 75);
    equals(
      (tenantOf(await inspect(root)).attempts as Record<string, Record<string, unknown>>).during
        ?.state,
      "dispatching",
    );
    equals(await ok({ action: "unknown", root, owner: alice, id: "during" }), true);
    equals(
      await ok({ action: "beginDispatch", root, owner: alice, id: "during" }),
      "already_consumed",
    );
  },
  "DUR-12": async (root) => {
    await setup(root);
    await ok({ action: "reserve", root, owner: alice, id: "no_retry", now: 10 });
    await ok({ action: "beginDispatch", root, owner: alice, id: "no_retry" });
    await ok({ action: "unknown", root, owner: alice, id: "no_retry" });
    const attempt =
      (tenantOf(await inspect(root)).attempts as Record<string, Record<string, unknown>>).no_retry;
    equals(attempt?.state, "dispatch_unknown");
    equals(attempt?.automaticRetry, false);
  },
  "DUR-13": async (root) => {
    await setup(root);
    equals(
      await ok({
        action: "transition",
        root,
        owner: alice,
        subject: "device",
        status: "revoked",
        version: 2,
      }),
      true,
    );
    const subjects = tenantOf(await inspect(root)).subjects as Record<
      string,
      Record<string, unknown>
    >;
    equals(subjects.device?.status, "revoked");
  },
  "DUR-14": async (root) => {
    await setup(root);
    await ok({
      action: "transition",
      root,
      owner: alice,
      subject: "device",
      status: "revoked",
      version: 2,
    });
    const before = await inspect(root);
    equals(
      await ok({
        action: "transition",
        root,
        owner: alice,
        subject: "device",
        status: "active",
        version: 2,
      }),
      false,
    );
    equals(
      await ok({
        action: "transition",
        root,
        owner: alice,
        subject: "device",
        status: "active",
        version: 3,
      }),
      true,
    );
    const after = await inspect(root);
    assert(Number(after.authorityGeneration) > Number(before.authorityGeneration));
    equals(
      (tenantOf(after).subjects as Record<string, Record<string, unknown>>).device?.version,
      3,
    );
  },
  "DUR-15": async (root) => {
    await setup(root);
    await ok({
      action: "issueChallenge",
      root,
      owner: alice,
      id: "challenge",
      hash: "correct",
      expiresAt: 90,
    });
    equals(
      await ok({
        action: "consumeChallenge",
        root,
        owner: alice,
        id: "challenge",
        hash: "wrong",
        now: 1,
      }),
      false,
    );
    equals(
      (tenantOf(await inspect(root)).challenges as Record<string, Record<string, unknown>>)
        .challenge?.used,
      false,
    );
    equals(
      await ok({
        action: "consumeChallenge",
        root,
        owner: alice,
        id: "challenge",
        hash: "correct",
        now: 1,
      }),
      true,
    );
  },
  "DUR-16": async (root) => {
    await setup(root);
    await ok({
      action: "issueChallenge",
      root,
      owner: alice,
      id: "race_challenge",
      hash: "bound",
      expiresAt: 90,
    });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        ok({
          action: "consumeChallenge",
          root,
          owner: alice,
          id: "race_challenge",
          hash: "bound",
          now: 1,
        })),
    );
    equals(results.filter(Boolean).length, 1);
  },
  "DUR-17": async (root) => {
    await setup(root);
    await ok({
      action: "issueChallenge",
      root,
      owner: alice,
      id: "enroll_challenge",
      hash: "bound",
      expiresAt: 90,
    });
    equals(
      await ok({
        action: "consumeChallenge",
        root,
        owner: alice,
        id: "enroll_challenge",
        hash: "wrong",
        now: 1,
        enrollmentId: "enrollment",
      }),
      false,
    );
    let tenant = tenantOf(await inspect(root));
    equals(Object.keys(tenant.enrollments as object).length, 0);
    equals(
      (tenant.challenges as Record<string, Record<string, unknown>>).enroll_challenge?.used,
      false,
    );
    equals(
      await ok({
        action: "consumeChallenge",
        root,
        owner: alice,
        id: "enroll_challenge",
        hash: "bound",
        now: 1,
        enrollmentId: "enrollment",
      }),
      true,
    );
    tenant = tenantOf(await inspect(root));
    equals(
      (tenant.enrollments as Record<string, Record<string, unknown>>).enrollment?.status,
      "pending",
    );
  },
  "DUR-18": async (root) => {
    await setup(root);
    await ok({ action: "legacy", root, owner: alice });
    equals(await ok({ action: "migrate", root }), true);
    const view = await inspect(root);
    equals(view.schemaVersion, 2);
    equals((tenantOf(view).replay as Record<string, number>)["nonce/legacy"], 999);
    assert(Number((view.highWatermarks as Record<string, number>).migrationGeneration) >= 1);
  },
  "DUR-19": async (root) => {
    await setup(root);
    await ok({ action: "legacy", root, owner: alice });
    const denied = await run({ action: "inspect", root, owner: alice });
    equals({ code: denied.code, outcome: denied.outcome }, { code: 0, outcome: "denied" });
  },
  "DUR-20": async (root) => {
    await setup(root);
    const snapshot = `${root}/snapshot.json`;
    await ok({ action: "snapshot", root, path: snapshot });
    await ok({
      action: "transition",
      root,
      owner: alice,
      subject: "device",
      status: "revoked",
      version: 2,
    });
    equals(await ok({ action: "restore", root, path: snapshot }), false);
    equals(
      (tenantOf(await inspect(root)).subjects as Record<string, Record<string, unknown>>).device
        ?.status,
      "revoked",
    );
  },
  "DUR-21": async (root) => {
    await setup(root);
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["ttl"],
        expiresAt: 10,
        now: 1,
      }),
      true,
    );
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["ttl"],
        expiresAt: 20,
        now: 10,
      }),
      false,
    );
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["ttl"],
        expiresAt: 20,
        now: 11,
      }),
      true,
    );
  },
  "DUR-22": async (root) => {
    await setup(root);
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["clock"],
        expiresAt: 300,
        now: 200,
      }),
      true,
    );
    equals(
      await ok({
        action: "consume",
        root,
        owner: alice,
        kind: "nonce",
        hashes: ["clock"],
        expiresAt: 300,
        now: 100,
      }),
      false,
    );
    equals((await inspect(root)).lastNow, 200);
  },
  "DUR-23": async (root) => {
    await setup(root);
    await ok({ action: "corrupt", root });
    const denied = await run({ action: "inspect", root, owner: alice });
    equals({ code: denied.code, outcome: denied.outcome }, { code: 0, outcome: "denied" });
  },
  "DUR-24": async (root) => {
    await setup(root, alice, "shared_custody");
    equals(await ok({ action: "seed", root, owner: bob, custodyRef: "shared_custody" }), false);
    equals((await inspect(root, bob)).exists, false);
  },
};

for (const scenario of scenarios) {
  Deno.test(`${scenario.id}: ${scenario.title}`, async () => {
    const root = await Deno.makeTempDir({ prefix: `cairn_${scenario.id}_` });
    try {
      const implementation = cases[scenario.id];
      if (!implementation) throw new Error(`missing scenario ${scenario.id}`);
      await implementation(root);
    } finally {
      await Deno.remove(root, { recursive: true }).catch(() => undefined);
    }
  });
}

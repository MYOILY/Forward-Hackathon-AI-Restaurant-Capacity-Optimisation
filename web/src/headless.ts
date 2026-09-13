import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { createReplaySession } from "./engine";
import { validateBundle, verifyBundleGeometry } from "./validation";
import type { ReplaySession, Snapshot } from "../../shared/contracts";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--stdio")) {
    let session: ReplaySession | undefined, snapshot: Snapshot | undefined;
    for await (const line of createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    })) {
      try {
        const command = JSON.parse(line);
        if (command.op === "init") {
          validateBundle(command.bundle);
          await verifyBundleGeometry(command.bundle);
          session = createReplaySession(
            command.bundle,
            command.staff_events ?? [],
          );
          snapshot = session.advanceTo(0);
        } else if (!session) throw new Error("Initialize a bundle first.");
        else if (command.op === "advance")
          snapshot = session.advanceTo(command.t);
        else if (command.op === "assessment") {
          session.submitAssessment(command.assessment);
          snapshot = session.advanceTo(snapshot!.t);
        } else if (command.op === "reset") {
          session.reset(command.staff_events ?? []);
          snapshot = session.advanceTo(0);
        } else throw new Error("Unknown planner command.");
        const normalized =
          command.op === "assessment"
            ? snapshot?.tables[command.assessment.table_id]?.last_assessment
            : undefined;
        process.stdout.write(
          JSON.stringify({
            snapshot,
            requests: session!.getAssessmentRequests(),
            ...(normalized?.id === command.assessment?.id
              ? { assessment: normalized }
              : {}),
          }) + "\n",
        );
      } catch (error) {
        process.stdout.write(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }) + "\n",
        );
      }
    }
    return;
  }
  const input = args[args.indexOf("--input") + 1];
  const output = args[args.indexOf("--output") + 1];
  if (
    !args.includes("--input") ||
    !args.includes("--output") ||
    !input ||
    !output
  )
    throw new Error("Usage: npm run replay -- --input INPUT --output OUTPUT");
  const request = JSON.parse(await readFile(input, "utf8"));
  if (!Array.isArray(request.times))
    throw new Error("Input needs a times array.");
  validateBundle(request.bundle);
  await verifyBundleGeometry(request.bundle);
  const session = createReplaySession(
    request.bundle,
    request.staff_events ?? [],
  );
  const snapshots = request.times.map((t: number) => session.advanceTo(t));
  await writeFile(output, JSON.stringify({ snapshots }, null, 2) + "\n");
}
main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});

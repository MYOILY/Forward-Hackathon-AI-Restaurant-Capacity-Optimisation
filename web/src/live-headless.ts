import { createInterface } from "node:readline";
import { createLiveSession } from "./live-engine";

let session: ReturnType<typeof createLiveSession> | undefined;
for await (const line of createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
})) {
  try {
    const command = JSON.parse(line);
    if (command.op === "init") {
      session = createLiveSession(command.config);
      process.stdout.write(
        JSON.stringify(session.send({ op: "tick", t: 0 })) + "\n",
      );
    } else {
      if (!session) throw new Error("Initialize a live session first.");
      process.stdout.write(JSON.stringify(session.send(command)) + "\n");
    }
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
      }) + "\n",
    );
  }
}

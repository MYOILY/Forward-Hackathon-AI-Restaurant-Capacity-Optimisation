import type { Bundle, Presence, StaffEvent } from "../../shared/contracts";
import { person, replayFixture } from "./replay-fixtures";

/** Input schedule only; expected behavior is authored in individual tests. */
export function fixture(
  presence: (t: number) => Presence = () => "absent",
  duration = 50,
): Bundle {
  return replayFixture(duration, (observation) => {
    observation.tables.T1 = presence(observation.t);
    if (observation.tables.T1 === "present") person(observation);
  });
}

/** Deliberately invalid input used only to test legacy-format rejection. */
export function legacyFixture(): Bundle {
  return {
    ...fixture(),
    schema_version: 1,
    policy: "legacy_v1",
  } as unknown as Bundle;
}

export function clean(t: number, id = `clean-${t}`, seq = 0): StaffEvent {
  return {
    id,
    t,
    table_id: "T1",
    action: "confirm_cleaned",
    source: "staff",
    seq,
  };
}

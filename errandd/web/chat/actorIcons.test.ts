import { expect, test } from "bun:test";
import { actorIcon } from "./actorIcons";

test("known service users reuse organization icons", () => {
  expect(actorIcon({ provider: "github", author: "vercel[bot]" })?.url).toBe(
    "https://github.com/vercel.png?size=48",
  );
  expect(actorIcon({ provider: "github", author: "datadog-official" })?.url).toBe(
    "https://github.com/DataDog.png?size=48",
  );
  expect(actorIcon({ provider: "sentry", author: "SENTRY[bot]" })?.label).toBe("Sentry");
});
test("other GitHub senders use their own avatar and invalid/non-GitHub senders fall back", () => {
  expect(actorIcon({ provider: "github", author: "alice" })?.url).toBe(
    "https://github.com/alice.png?size=48",
  );
  expect(actorIcon({ provider: "github", author: "https://other.example/avatar" })).toBeNull();
  expect(actorIcon({ provider: "webhook", author: "alice" })).toBeNull();
});

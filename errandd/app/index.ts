import { start } from "./commands/start";
import { stop, stopAll } from "./commands/stop";
import { clear } from "./commands/clear";
import { status } from "./commands/status";
import { telegram } from "./commands/telegram";
import { discord } from "./commands/discord";
import { slack } from "./commands/slack";
import { send } from "./commands/send";

const args = process.argv.slice(2);
const command = args[0];

// CLI dispatch — each command owns its own lifecycle; fire-and-forget at the
// entry point (`void` marks the intentional non-await for no-floating-promises).
if (command === "--stop-all") {
  void stopAll();
} else if (command === "--stop") {
  void stop();
} else if (command === "--clear") {
  void clear();
} else if (command === "start") {
  void start(args.slice(1));
} else if (command === "status") {
  void status(args.slice(1));
} else if (command === "telegram") {
  void telegram();
} else if (command === "discord") {
  void discord();
} else if (command === "slack") {
  void slack();
} else if (command === "send") {
  void send(args.slice(1));
} else {
  void start();
}

import { run } from "./ui/terminal/index";

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

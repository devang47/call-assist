import { env } from "./config/env.js";
import { buildApp } from "./server/app.js";
import { initTelemetry } from "./lib/telemetry.js";

async function main() {
  await initTelemetry();
  const app = await buildApp();

  try {
    await app.listen({ port: env.PORT, host: env.HOST });
    console.log(`Call-Assist server running on ${env.HOST}:${env.PORT}`);
    console.log(`Practice: ${env.PRACTICE_NAME}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();

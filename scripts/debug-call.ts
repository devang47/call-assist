import "dotenv/config";
import Twilio from "twilio";

const client = Twilio(process.env.TWILIO_ACCOUNT_SID!, process.env.TWILIO_AUTH_TOKEN!);

async function main() {
  // Fetch recent calls
  const calls = await client.calls.list({ limit: 5 });
  for (const call of calls) {
    console.log(`\n--- Call ${call.sid} ---`);
    console.log(`  Status: ${call.status}`);
    console.log(`  From: ${call.from} → To: ${call.to}`);
    console.log(`  Duration: ${call.duration}s`);
    console.log(`  Start: ${call.startTime}`);

    // Fetch notifications (errors/warnings) for this call
    const notifications = await client.calls(call.sid).notifications.list();
    if (notifications.length === 0) {
      console.log("  Notifications: none");
    }
    for (const n of notifications) {
      console.log(`  ⚠ [${n.log}] ${n.errorCode}: ${n.messageText}`);
      if (n.moreInfo) console.log(`    More info: ${n.moreInfo}`);
    }
  }

  // Also check the debugger for recent alerts
  console.log("\n\n=== Recent Alerts ===");
  const alerts = await client.monitor.alerts.list({ limit: 10 });
  for (const alert of alerts) {
    console.log(`\n[${alert.dateCreated}] Error ${alert.errorCode}`);
    console.log(`  ${alert.alertText?.substring(0, 200)}`);
    if (alert.moreInfo) console.log(`  More info: ${alert.moreInfo}`);
  }
}

main().catch(console.error);

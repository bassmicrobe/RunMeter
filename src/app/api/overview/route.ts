import { createDisconnectedDashboardSnapshot } from "@/lib/disconnected-dashboard";

export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(createDisconnectedDashboardSnapshot(), {
    headers: {
      "Cache-Control": "no-store, max-age=0",
    },
  });
}

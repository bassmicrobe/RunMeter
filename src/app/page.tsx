import { RunMeterDashboard } from "@/components/runmeter/dashboard";
import { createDisconnectedDashboardSnapshot } from "@/lib/disconnected-dashboard";

export default function Home() {
  return (
    <RunMeterDashboard initialSnapshot={createDisconnectedDashboardSnapshot()} />
  );
}

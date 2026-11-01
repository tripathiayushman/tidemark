import { SettingsNav } from "./nav";
import { PageHeader } from "@/components/tm/page-header";

export default function SettingsLayout({ children }: LayoutProps<"/settings">) {
  return (
    <div>
      <PageHeader title="Settings" />
      <div className="flex flex-col gap-6 p-6 md:flex-row">
        <SettingsNav />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </div>
  );
}

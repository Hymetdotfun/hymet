import { OwnerConsole } from "../../components/owner-console";
export const metadata = { title: "Owner · HYMET", robots: { index: false } };
export default function Owner() {
  return (
    <main className="page-shell fees-page">
      <OwnerConsole />
    </main>
  );
}

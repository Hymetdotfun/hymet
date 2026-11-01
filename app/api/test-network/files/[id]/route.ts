import { NextResponse } from "next/server";
import { readTestFile } from "../../../../../lib/test-network-files";
export const runtime = "nodejs";

// Serves launch artwork and metadata stored by the guarded local test network. 404 everywhere else.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const file = await readTestFile((await params).id);
  if (!file) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(new Uint8Array(file.bytes), {
    headers: { "Content-Type": file.type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

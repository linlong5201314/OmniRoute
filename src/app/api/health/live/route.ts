import { NextResponse } from "next/server";

/**
 * GET /api/health/live — process-only liveness probe.
 *
 * This endpoint intentionally avoids SQLite, provider checks, and other runtime
 * dependencies. It is suitable for platform health checks that only need to
 * know whether the HTTP server has started and can respond.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    }
  );
}

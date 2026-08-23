import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { markHandled, setSnooze, setStage } from "@/lib/turn/actions";
import type { AllStages } from "@/types/db";

/**
 * The inline actions on a Today row (section 2.3).
 *
 * A thin authenticated wrapper over lib/turn/actions.ts, which the Telegram
 * card calls too. Deliberately small: everything here either records something
 * Eddie has already done or changes one field, and nothing sends a message.
 */
const ACTIONS = ["done", "snooze", "unsnooze", "stage"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(request: NextRequest) {
  const supabase = await createClient();
  const { data: authData } = await supabase.auth.getClaims();
  if (!authData?.claims) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const userId = authData.claims.sub as string;

  const { contactId, action, days, stage } = (await request.json()) as {
    contactId?: string;
    action?: Action;
    days?: number;
    stage?: AllStages;
  };

  if (!contactId || !action || !ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: "contactId and a valid action are required" },
      { status: 400 }
    );
  }

  const service = createServiceClient();

  const result =
    action === "done"
      ? await markHandled(service, userId, contactId)
      : action === "snooze"
        ? await setSnooze(service, userId, contactId, Number(days) || 1)
        : action === "unsnooze"
          ? await setSnooze(service, userId, contactId, null)
          : await setStage(service, userId, contactId, stage as AllStages);

  if (!result.ok) {
    // "Contact not found" is the ownership check failing, which for an
    // authenticated caller means the id is not theirs. 404 rather than 403 so
    // the response does not confirm that some other user's contact exists.
    const status = result.error === "Contact not found" ? 404 : 400;
    return NextResponse.json({ error: result.error }, { status });
  }

  return NextResponse.json(result);
}

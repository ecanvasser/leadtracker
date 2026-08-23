import { redirect } from "next/navigation";

/**
 * Phase 8 section 5 — Today is home.
 *
 * The board was the landing page for six phases. It is a map: it shows where
 * every lead stands, but working out what to do from it means scanning
 * columns and reconstructing the answer. Today is already sorted by the only
 * question that decides whether anything needs doing.
 *
 * The board is still one click away and unchanged in what it can do.
 */
export default function Home() {
  redirect("/today");
}

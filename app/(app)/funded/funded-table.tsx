"use client";

/**
 * Closed deals.
 *
 * Phase 7 D1: the pipeline had no terminal success state, so a funded loan sat
 * in Processing forever or got deleted. This is the Adverse treatment applied
 * to the opposite outcome — off the board, on its own page, still a real
 * contact you can open and read.
 *
 * Deliberately a near-twin of adverse-table.tsx rather than a shared abstraction.
 * The two pages diverge in what they show (a reason vs a close date) and in
 * what "move back" means, and one component with two modes would be harder to
 * read than two that are each obvious.
 */

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Contact,
  LOAN_TYPE_LABELS,
  CRM_LABELS,
  PIPELINE_STAGES,
  STAGE_LABELS,
  type PipelineStage,
} from "@/types/db";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ContactDialog } from "@/components/contact/contact-dialog";
import { toast } from "sonner";
import { ArrowLeft } from "lucide-react";

interface FundedTableProps {
  initialContacts: Contact[];
  userId: string;
}

export function FundedTable({ initialContacts, userId }: FundedTableProps) {
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    const channel = supabase
      .channel("funded-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        async () => {
          const { data } = await supabase
            .from("contacts")
            .select("*")
            .eq("stage", "funded")
            .order("updated_at", { ascending: false });
          if (data) setContacts(data as Contact[]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

  /** Reopening a closed deal — a funded loan that fell apart, or a misclick. */
  async function handleMoveBack(contactId: string, newStage: PipelineStage) {
    const { data: maxPos } = await supabase
      .from("contacts")
      .select("position")
      .eq("stage", newStage)
      .order("position", { ascending: false })
      .limit(1)
      .single();

    const position = maxPos ? maxPos.position + 1000 : 1000;

    const { error } = await supabase
      .from("contacts")
      .update({ stage: newStage, position })
      .eq("id", contactId);

    if (error) {
      toast.error("Failed to move contact");
    } else {
      toast.success(`Moved back to ${STAGE_LABELS[newStage]}`);
      setContacts((prev) => prev.filter((c) => c.id !== contactId));
    }
  }

  function handleContactUpdated(updated: Contact) {
    if (updated.stage === "funded") {
      setContacts((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
    } else {
      setContacts((prev) => prev.filter((c) => c.id !== updated.id));
    }
    setSelectedContactId(null);
  }

  function handleContactDeleted(id: string) {
    setContacts((prev) => prev.filter((c) => c.id !== id));
    setSelectedContactId(null);
  }

  const selectedContact = contacts.find((c) => c.id === selectedContactId) ?? null;

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto w-full">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-lg font-semibold">Funded</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Closed deals. They leave the board so Processing stays a list of
            what is still in flight.
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {contacts.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          Nothing funded yet.
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left font-medium px-4 py-3">Name</th>
                <th className="text-left font-medium px-4 py-3">Loan Type</th>
                <th className="text-left font-medium px-4 py-3">Notes</th>
                <th className="text-left font-medium px-4 py-3">Funded</th>
                <th className="text-right font-medium px-4 py-3">Reopen</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((contact) => (
                <tr
                  key={contact.id}
                  className="border-b last:border-0 hover:bg-muted/30 transition-colors"
                >
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setSelectedContactId(contact.id)}
                      className="font-medium hover:underline text-left"
                    >
                      {contact.name}
                    </button>
                    <div className="mt-0.5">
                      <Badge variant="outline" className="text-[10px] mr-1">
                        {CRM_LABELS[contact.crm]}
                      </Badge>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="secondary" className="text-xs">
                      {LOAN_TYPE_LABELS[contact.loan_type]}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground max-w-[240px] truncate">
                    {contact.notes || "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {new Date(contact.updated_at).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                    })}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Select
                      onValueChange={(v) =>
                        handleMoveBack(contact.id, v as PipelineStage)
                      }
                    >
                      <SelectTrigger className="w-[140px] h-8 text-xs ml-auto">
                        <ArrowLeft className="h-3 w-3 mr-1" />
                        <SelectValue placeholder="Move to..." />
                      </SelectTrigger>
                      <SelectContent>
                        {PIPELINE_STAGES.map((s) => (
                          <SelectItem key={s} value={s}>
                            {STAGE_LABELS[s]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedContact && (
        <ContactDialog
          contact={selectedContact}
          userId={userId}
          open={!!selectedContactId}
          onOpenChange={(open) => {
            if (!open) setSelectedContactId(null);
          }}
          onUpdated={handleContactUpdated}
          onDeleted={handleContactDeleted}
        />
      )}
    </div>
  );
}

"use client";

import { useState, useEffect } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  Contact,
  LOAN_TYPE_LABELS,
  CRM_LABELS,
  ADVERSE_REASON_LABELS,
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

interface AdverseTableProps {
  initialContacts: Contact[];
  userId: string;
}

export function AdverseTable({ initialContacts, userId }: AdverseTableProps) {
  const [contacts, setContacts] = useState<Contact[]>(initialContacts);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const supabase = createClient();

  useEffect(() => {
    const channel = supabase
      .channel("adverse-realtime")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "contacts" },
        async () => {
          const { data } = await supabase
            .from("contacts")
            .select("*")
            .eq("stage", "adverse")
            .order("stage_changed_at", { ascending: false });
          if (data) setContacts(data as Contact[]);
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [supabase]);

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
      .update({ stage: newStage, position, adverse_reason: null })
      .eq("id", contactId);

    if (error) {
      toast.error("Failed to move contact");
    } else {
      toast.success(`Moved back to ${STAGE_LABELS[newStage]}`);
      setContacts((prev) => prev.filter((c) => c.id !== contactId));
    }
  }

  function handleContactUpdated(updated: Contact) {
    if (updated.stage === "adverse") {
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
          <h1 className="text-lg font-semibold">Adverse</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Contacts that fell out of the pipeline. Move them back when circumstances change.
          </p>
        </div>
        <Badge variant="secondary" className="text-xs">
          {contacts.length} contact{contacts.length !== 1 ? "s" : ""}
        </Badge>
      </div>

      {contacts.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground text-sm">
          No adverse contacts. That&apos;s a good thing.
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/50">
                <th className="text-left font-medium px-4 py-3">Name</th>
                <th className="text-left font-medium px-4 py-3">Loan Type</th>
                <th className="text-left font-medium px-4 py-3">Reason</th>
                <th className="text-left font-medium px-4 py-3">Notes</th>
                <th className="text-left font-medium px-4 py-3">Date</th>
                <th className="text-right font-medium px-4 py-3">Move Back</th>
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
                  <td className="px-4 py-3 text-muted-foreground">
                    {contact.adverse_reason
                      ? ADVERSE_REASON_LABELS[contact.adverse_reason]
                      : "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">
                    {contact.notes || "—"}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                    {/*
                      stage_changed_at, not updated_at. This column means
                      "when did this happen", and updated_at moves on any edit
                      — including the Phase 7 backfill, which reset it on every
                      row. stage_changed_at is the actual moment the contact
                      landed here.
                    */}
                    {new Date(contact.stage_changed_at ?? contact.updated_at).toLocaleDateString("en-US", {
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

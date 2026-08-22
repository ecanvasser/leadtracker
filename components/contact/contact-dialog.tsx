"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { mapBonzoLoanType, getMortgageFields } from "@/lib/bonzo/client";
import { findExistingBonzoContact } from "@/lib/db/contacts";
import {
  Contact,
  Task,
  LoanType,
  CRM,
  AllStages,
  AdverseReason,
  LOAN_TYPES,
  CRM_OPTIONS,
  ALL_STAGES,
  QUEUE_ELIGIBLE_STAGES,
  ADVERSE_REASONS,
  LOAN_TYPE_LABELS,
  CRM_LABELS,
  STAGE_LABELS,
  ADVERSE_REASON_LABELS,
  DEFAULT_STAGE,
  isQueueEligible,
} from "@/types/db";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { toast } from "sonner";
import { Trash2, Plus, Search, Loader2, Download, AlertTriangle } from "lucide-react";

/**
 * The stage a lead has to be in to be worked, named for the user.
 *
 * Derived rather than written out: Phase 7 moved automation from Hot Leads to
 * Quoted – Follow Up, and these strings said "Hot Leads" in two places. Reading
 * it off the constant means the next move updates the copy too.
 */
const QUEUE_ELIGIBLE_LABEL = QUEUE_ELIGIBLE_STAGES.map(
  (s) => STAGE_LABELS[s]
).join(" or ");

interface ContactDialogProps {
  contact: Contact | null;
  userId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (contact: Contact) => void;
  onUpdated?: (contact: Contact) => void;
  onDeleted?: (id: string) => void;
  onTasksChanged?: () => void;
}

type NewLeadMode = "manual" | "bonzo";

interface BonzoSearchResult {
  id: number;
  name: string;
  email: string;
  phone: string | null;
}

export function ContactDialog({
  contact,
  userId,
  open,
  onOpenChange,
  onCreated,
  onUpdated,
  onDeleted,
  onTasksChanged,
}: ContactDialogProps) {
  const isNew = !contact;
  const supabase = createClient();
  const router = useRouter();

  const [mode, setMode] = useState<NewLeadMode>("manual");
  const [bonzoEmail, setBonzoEmail] = useState("");
  const [bonzoSearching, setBonzoSearching] = useState(false);
  const [bonzoResult, setBonzoResult] = useState<BonzoSearchResult | null>(null);
  // The complete Bonzo record. Needed to map the loan type and to seed
  // insights_cache; the display stub above carries neither.
  const [bonzoFull, setBonzoFull] = useState<Record<string, unknown> | null>(null);
  const [bonzoError, setBonzoError] = useState<string | null>(null);
  const [bonzoImporting, setBonzoImporting] = useState(false);
  // 5.1 — whether the loan type below came from the Bonzo record or is just the
  // fallback. A wrong guess and a confident match used to look identical.
  const [loanTypeSource, setLoanTypeSource] = useState<"bonzo" | "fallback" | null>(null);
  // 5.2 — a prospect already on the board, in any stage.
  const [duplicate, setDuplicate] = useState<Pick<Contact, "id" | "name" | "stage"> | null>(null);

  const [name, setName] = useState(contact?.name ?? "");
  const [loanType, setLoanType] = useState<LoanType>(contact?.loan_type ?? "purchase");
  const [crm, setCrm] = useState<CRM>(contact?.crm ?? "bonzo");
  const [stage, setStage] = useState<AllStages>(contact?.stage ?? DEFAULT_STAGE);
  const [adverseReason, setAdverseReason] = useState<AdverseReason | "">(contact?.adverse_reason ?? "");
  const [notes, setNotes] = useState(contact?.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");
  const [loadingTasks, setLoadingTasks] = useState(false);

  useEffect(() => {
    if (contact) {
      setName(contact.name);
      setLoanType(contact.loan_type);
      setCrm(contact.crm);
      setStage(contact.stage);
      setAdverseReason(contact.adverse_reason ?? "");
      setNotes(contact.notes ?? "");
      loadTasks();
    }
  }, [contact?.id]);

  useEffect(() => {
    if (!open) {
      setMode("manual");
      setBonzoEmail("");
      setBonzoResult(null);
      setBonzoFull(null);
      setBonzoError(null);
      setLoanTypeSource(null);
      setDuplicate(null);
      // Stage and loan type are shared with the edit path, so only the
      // new-lead dialog may reset them — otherwise reopening the same contact
      // would show defaults instead of that contact's own values (the effect
      // below is keyed on contact.id and would not re-run to correct it).
      if (!contact) {
        setStage(DEFAULT_STAGE);
        setLoanType("purchase");
      }
    }
  }, [open, contact]);

  async function loadTasks() {
    if (!contact) return;
    setLoadingTasks(true);
    const { data } = await supabase
      .from("tasks")
      .select("*")
      .eq("contact_id", contact.id)
      .order("is_done", { ascending: true })
      .order("created_at", { ascending: false });
    setTasks(data ?? []);
    setLoadingTasks(false);
  }

  async function handleBonzoSearch() {
    if (!bonzoEmail.trim()) return;
    setBonzoSearching(true);
    setBonzoResult(null);
    setBonzoFull(null);
    setBonzoError(null);
    setLoanTypeSource(null);
    setDuplicate(null);

    try {
      const res = await fetch("/api/insights/search-bonzo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: bonzoEmail.trim() }),
      });
      const data = await res.json();

      if (data.error) {
        setBonzoError(data.error);
      } else if (!data.found) {
        setBonzoError("No prospect found with that email in Bonzo.");
      } else {
        setBonzoResult(data.prospect);
        setBonzoFull(data.fullProspect ?? null);

        // Seed the selectors from the record so the import button acts on what
        // is actually shown, not on values computed at click time.
        const mapped = mapBonzoLoanType(getMortgageFields(data.fullProspect ?? null));
        setLoanType(mapped ?? "purchase");
        setLoanTypeSource(mapped ? "bonzo" : "fallback");

        // 5.2 — checked here rather than at import so the answer is on screen
        // before the button is pressed.
        setDuplicate(
          await findExistingBonzoContact(supabase, {
            prospectId: data.prospect?.id,
            email: data.prospect?.email ?? bonzoEmail.trim(),
          })
        );
      }
    } catch {
      setBonzoError("Search failed. Try again.");
    }
    setBonzoSearching(false);
  }

  function openDuplicate() {
    if (!duplicate) return;
    onOpenChange(false);
    router.push(`/contacts/${duplicate.id}`);
  }

  async function handleBonzoImport() {
    if (!bonzoResult) return;

    // 5.2 — never create a second row for a prospect already on the board. The
    // check ran at search time; re-read here because the state could have moved
    // on (another tab, a slow search) between then and this click.
    if (duplicate) {
      toast.error(`${duplicate.name} is already on the board`, {
        description: `They are in ${STAGE_LABELS[duplicate.stage]}. Open that contact instead.`,
      });
      return;
    }

    // An adverse lead without a reason is a hole in the funnel record — the
    // manual path already refuses it, and importing straight to Adverse must
    // not be the way around that.
    if (stage === "adverse" && !adverseReason) {
      toast.error("Select an adverse reason");
      return;
    }

    setBonzoImporting(true);

    const importName = bonzoResult.name || bonzoEmail.trim();

    // Position is computed inside the stage being imported into. Against
    // hot_lead it produced a position from the wrong column, so the card landed
    // in an arbitrary spot in its actual one.
    const { data: maxPos } = await supabase
      .from("contacts")
      .select("position")
      .eq("stage", stage)
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle();

    const position = maxPos ? maxPos.position + 1000 : 1000;

    const { data, error } = await supabase
      .from("contacts")
      .insert({
        user_id: userId,
        name: importName,
        // Seeded from the Bonzo record at search time and overridable above.
        // Importing every lead as a purchase meant a cash-out refinance was
        // labelled wrong and every draft written for it reasoned from the
        // wrong product.
        loan_type: loanType,
        crm: "bonzo" as CRM,
        stage,
        adverse_reason: stage === "adverse" ? adverseReason || null : null,
        position,
        bonzo_prospect_id: bonzoResult.id,
        bonzo_email: bonzoResult.email,
        // 5.4 — enrolled regardless of stage, so the lead is ready the moment
        // it is moved into an active one. Inert enrollment is only a problem
        // when it is silent, so the selector says so out loud.
        insights_enabled: true,
        // Reminders need a number; without this it was fetched and discarded.
        phone: bonzoResult.phone ?? null,
      })
      .select()
      .single();

    if (error) {
      toast.error("Failed to import contact");
      setBonzoImporting(false);
      return;
    }

    const created = data as Contact;
    onCreated?.(created);

    // Seed insights_cache. Import sets insights_enabled, so without this the
    // lead entered the queue with no history at all — meaning unanswered-reply
    // detection, the highest-priority signal in the engine, could not fire for
    // it until someone opened the contact and hit Refresh by hand.
    try {
      const res = await fetch("/api/insights/enable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contactId: created.id,
          bonzoProspectId: bonzoResult.id,
          bonzoEmail: bonzoResult.email,
          bonzoProspectData: bonzoFull ?? bonzoResult,
        }),
      });
      const seeded = await res.json();

      if (seeded.error) {
        // The contact exists and is usable; only its history is missing.
        toast.warning(`${importName} imported, but history did not load`, {
          description: "Open the contact and hit Refresh to pull it.",
        });
      } else {
        toast.success(`${importName} imported with history`, {
          description: isQueueEligible(stage)
            ? undefined
            : `Parked in ${STAGE_LABELS[stage]} — not worked until it moves to ${QUEUE_ELIGIBLE_LABEL}.`,
        });
      }
    } catch {
      toast.warning(`${importName} imported, but history did not load`);
    }

    setBonzoImporting(false);
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Name is required");
      return;
    }

    if (stage === "adverse" && !adverseReason) {
      toast.error("Select an adverse reason");
      return;
    }

    setSaving(true);

    const contactData = {
      name: name.trim(),
      loan_type: loanType,
      crm,
      stage,
      adverse_reason: stage === "adverse" ? adverseReason || null : null,
      notes: notes.trim() || null,
    };

    if (isNew) {
      const { data: maxPos } = await supabase
        .from("contacts")
        .select("position")
        .eq("stage", stage)
        .order("position", { ascending: false })
        .limit(1)
        .single();

      const position = maxPos ? maxPos.position + 1000 : 1000;

      const { data, error } = await supabase
        .from("contacts")
        .insert({ user_id: userId, ...contactData, position })
        .select()
        .single();

      if (error) {
        toast.error("Failed to create contact");
      } else {
        toast.success("Lead added");
        onCreated?.(data as Contact);
      }
    } else {
      const { data, error } = await supabase
        .from("contacts")
        .update(contactData)
        .eq("id", contact.id)
        .select()
        .single();

      if (error) {
        toast.error("Failed to update contact");
      } else {
        toast.success("Contact updated");
        onUpdated?.(data as Contact);
      }
    }

    setSaving(false);
  }

  async function handleDelete() {
    if (!contact) return;
    const { error } = await supabase
      .from("contacts")
      .delete()
      .eq("id", contact.id);

    if (error) {
      toast.error("Failed to delete contact");
    } else {
      toast.success("Contact deleted");
      onDeleted?.(contact.id);
    }
  }

  async function handleAddTask() {
    if (!contact || !newTaskTitle.trim()) return;

    const { error } = await supabase.from("tasks").insert({
      user_id: userId,
      contact_id: contact.id,
      title: newTaskTitle.trim(),
      due_date: newTaskDue || null,
    });

    if (error) {
      toast.error("Failed to add task");
    } else {
      setNewTaskTitle("");
      setNewTaskDue("");
      loadTasks();
      onTasksChanged?.();
    }
  }

  async function handleCompleteTask(taskId: string) {
    const { error } = await supabase
      .from("tasks")
      .update({ is_done: true, completed_at: new Date().toISOString() })
      .eq("id", taskId);

    if (error) {
      toast.error("Failed to complete task");
    } else {
      loadTasks();
      onTasksChanged?.();
    }
  }

  async function handleDeleteTask(taskId: string) {
    const { error } = await supabase.from("tasks").delete().eq("id", taskId);
    if (error) {
      toast.error("Failed to delete task");
    } else {
      loadTasks();
      onTasksChanged?.();
    }
  }

  const openTasks = tasks.filter((t) => !t.is_done);
  const completedTasks = tasks.filter((t) => t.is_done).slice(0, 5);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isNew ? "New Lead" : contact.name}</DialogTitle>
        </DialogHeader>

        {/* Mode toggle for new leads */}
        {isNew && (
          <div className="flex rounded-lg border border-border p-0.5 gap-0.5">
            <button
              onClick={() => setMode("manual")}
              className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${
                mode === "manual"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              Manual entry
            </button>
            <button
              onClick={() => setMode("bonzo")}
              className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors flex items-center justify-center gap-1.5 ${
                mode === "bonzo"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Download className="h-3 w-3" />
              Import from Bonzo
            </button>
          </div>
        )}

        {/* Bonzo import mode */}
        {isNew && mode === "bonzo" && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Search for a prospect in Bonzo by email. The contact will be created with insights already enabled.
            </p>

            <div className="flex gap-2">
              <Input
                type="email"
                placeholder="Prospect's email in Bonzo"
                value={bonzoEmail}
                onChange={(e) => setBonzoEmail(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleBonzoSearch();
                }}
              />
              <Button
                onClick={handleBonzoSearch}
                disabled={bonzoSearching || !bonzoEmail.trim()}
                size="icon"
              >
                {bonzoSearching ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Search className="h-4 w-4" />
                )}
              </Button>
            </div>

            {bonzoError && (
              <p className="text-sm text-destructive">{bonzoError}</p>
            )}

            {bonzoResult && (
              <Card>
                <CardContent className="pt-4 space-y-3">
                  <div>
                    <p className="font-medium text-sm">{bonzoResult.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {bonzoResult.email}
                    </p>
                    {bonzoResult.phone && (
                      <p className="text-xs text-muted-foreground">
                        {bonzoResult.phone}
                      </p>
                    )}
                  </div>

                  {/* 5.2 — already on the board. Importing again would create a
                      second row for the same prospect, which is never what is
                      wanted, so the import is refused rather than warned about. */}
                  {duplicate ? (
                    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2.5 space-y-2">
                      <p className="text-xs text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px" />
                        <span>
                          <b>{duplicate.name}</b> is already on the board, in{" "}
                          <b>{STAGE_LABELS[duplicate.stage]}</b>.
                        </span>
                      </p>
                      <div className="flex gap-2">
                        <Button size="sm" className="flex-1" onClick={openDuplicate}>
                          Open that contact
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setBonzoResult(null);
                            setBonzoFull(null);
                            setBonzoEmail("");
                            setDuplicate(null);
                            setLoanTypeSource(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {/* 5.1 — stage and loan type are chosen before importing.
                          They write to the same state the manual path uses. */}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Stage</Label>
                          <Select value={stage} onValueChange={(v) => setStage(v as AllStages)}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ALL_STAGES.map((st) => (
                                <SelectItem key={st} value={st}>
                                  {STAGE_LABELS[st]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <div className="space-y-1.5">
                          <Label className="text-xs">Loan Type</Label>
                          <Select value={loanType} onValueChange={(v) => {
                            setLoanType(v as LoanType);
                            setLoanTypeSource(null);
                          }}>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {LOAN_TYPES.map((lt) => (
                                <SelectItem key={lt} value={lt}>
                                  {LOAN_TYPE_LABELS[lt]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          {loanTypeSource === "bonzo" && (
                            <p className="text-[10px] text-muted-foreground">
                              From Bonzo: {LOAN_TYPE_LABELS[loanType]}
                            </p>
                          )}
                          {loanTypeSource === "fallback" && (
                            <p className="text-[10px] text-amber-600 dark:text-amber-400">
                              Bonzo had no loan type — defaulted to Purchase.
                            </p>
                          )}
                        </div>
                      </div>

                      {stage === "adverse" && (
                        <div className="space-y-1.5">
                          <Label className="text-xs">Adverse Reason</Label>
                          <Select
                            value={adverseReason}
                            onValueChange={(v) => setAdverseReason(v as AdverseReason)}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select reason..." />
                            </SelectTrigger>
                            <SelectContent>
                              {ADVERSE_REASONS.map((r) => (
                                <SelectItem key={r} value={r}>
                                  {ADVERSE_REASON_LABELS[r]}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {/* 5.4 — enrollment happens either way, so say plainly
                          when it will sit inert. Silent inertness is the bug
                          this whole phase is guarding against. */}
                      {!isQueueEligible(stage) && (
                        <p className="text-[11px] text-muted-foreground">
                          Insights will be enabled, but a lead in{" "}
                          {STAGE_LABELS[stage]} is not worked by the queue — no
                          classification, queue cards, or Telegram pushes until
                          you move it to {QUEUE_ELIGIBLE_LABEL}.
                        </p>
                      )}

                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleBonzoImport}
                          disabled={bonzoImporting}
                          className="flex-1"
                        >
                          {bonzoImporting ? (
                            <>
                              <Loader2 className="h-3 w-3 animate-spin mr-1.5" />
                              Importing...
                            </>
                          ) : (
                            `Import to ${STAGE_LABELS[stage]}`
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setBonzoResult(null);
                            setBonzoFull(null);
                            setBonzoEmail("");
                            setLoanTypeSource(null);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        )}

        {/* Manual entry / edit mode */}
        {(mode === "manual" || !isNew) && (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Contact name"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Loan Type</Label>
                <Select value={loanType} onValueChange={(v) => setLoanType(v as LoanType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOAN_TYPES.map((lt) => (
                      <SelectItem key={lt} value={lt}>
                        {LOAN_TYPE_LABELS[lt]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label>CRM</Label>
                <Select value={crm} onValueChange={(v) => setCrm(v as CRM)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CRM_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c}>
                        {CRM_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Stage</Label>
              <Select value={stage} onValueChange={(v) => setStage(v as AllStages)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STAGE_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {stage === "adverse" && (
              <div className="space-y-2">
                <Label>Adverse Reason</Label>
                <Select value={adverseReason} onValueChange={(v) => setAdverseReason(v as AdverseReason)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select reason..." />
                  </SelectTrigger>
                  <SelectContent>
                    {ADVERSE_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {ADVERSE_REASON_LABELS[r]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="notes">Notes</Label>
              <textarea
                id="notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes..."
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
              />
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={saving} className="flex-1">
                {saving ? "Saving..." : isNew ? "Add Lead" : "Save Changes"}
              </Button>
              {!isNew && (
                confirmDelete ? (
                  <div className="flex gap-1">
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={handleDelete}
                    >
                      Confirm
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setConfirmDelete(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="h-4 w-4 text-muted-foreground" />
                  </Button>
                )
              )}
            </div>

            {!isNew && (
              <>
                <hr className="border-border/50" />

                <div className="space-y-3">
                  <h3 className="text-sm font-medium">Tasks</h3>

                  <div className="flex gap-2">
                    <Input
                      placeholder="Task title"
                      value={newTaskTitle}
                      onChange={(e) => setNewTaskTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleAddTask();
                      }}
                      className="flex-1"
                    />
                    <Input
                      type="date"
                      value={newTaskDue}
                      onChange={(e) => setNewTaskDue(e.target.value)}
                      className="w-[130px]"
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={handleAddTask}
                      disabled={!newTaskTitle.trim()}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>

                  {loadingTasks ? (
                    <p className="text-xs text-muted-foreground">Loading...</p>
                  ) : (
                    <div className="space-y-1.5">
                      {openTasks.map((task) => (
                        <div
                          key={task.id}
                          className="flex items-center gap-2 group"
                        >
                          <Checkbox
                            onCheckedChange={() => handleCompleteTask(task.id)}
                          />
                          <span className="text-sm flex-1">{task.title}</span>
                          {task.due_date && (
                            <span className="text-[10px] text-muted-foreground">
                              {new Date(task.due_date + "T00:00:00").toLocaleDateString(
                                "en-US",
                                { month: "short", day: "numeric" }
                              )}
                            </span>
                          )}
                          <button
                            onClick={() => handleDeleteTask(task.id)}
                            className="opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <Trash2 className="h-3 w-3 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
                      ))}
                      {openTasks.length === 0 && (
                        <p className="text-xs text-muted-foreground">
                          No open tasks
                        </p>
                      )}
                      {completedTasks.length > 0 && (
                        <>
                          <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-3">
                            Recently completed
                          </p>
                          {completedTasks.map((task) => (
                            <div
                              key={task.id}
                              className="flex items-center gap-2"
                            >
                              <Checkbox checked disabled />
                              <span className="text-sm text-muted-foreground line-through">
                                {task.title}
                              </span>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
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
  ADVERSE_REASONS,
  LOAN_TYPE_LABELS,
  CRM_LABELS,
  STAGE_LABELS,
  ADVERSE_REASON_LABELS,
} from "@/types/db";
import { Badge } from "@/components/ui/badge";
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
import { toast } from "sonner";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import { InsightsPanel } from "./insights-panel";
import { useRouter } from "next/navigation";

interface ContactDetailProps {
  contact: Contact;
  initialTasks: Task[];
  userId: string;
}

export function ContactDetail({
  contact: initialContact,
  initialTasks,
  userId,
}: ContactDetailProps) {
  const router = useRouter();
  const supabase = createClient();
  const [contact, setContact] = useState(initialContact);
  const [tasks, setTasks] = useState(initialTasks);

  const [name, setName] = useState(contact.name);
  const [loanType, setLoanType] = useState<LoanType>(contact.loan_type);
  const [crm, setCrm] = useState<CRM>(contact.crm);
  const [stage, setStage] = useState<AllStages>(contact.stage);
  const [adverseReason, setAdverseReason] = useState<AdverseReason | "">(
    contact.adverse_reason ?? ""
  );
  const [notes, setNotes] = useState(contact.notes ?? "");
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [newTaskTitle, setNewTaskTitle] = useState("");
  const [newTaskDue, setNewTaskDue] = useState("");

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
    const { data, error } = await supabase
      .from("contacts")
      .update({
        name: name.trim(),
        loan_type: loanType,
        crm,
        stage,
        adverse_reason: stage === "adverse" ? adverseReason || null : null,
        notes: notes.trim() || null,
      })
      .eq("id", contact.id)
      .select()
      .single();

    if (error) {
      toast.error("Failed to save");
    } else {
      toast.success("Saved");
      setContact(data as Contact);
    }
    setSaving(false);
  }

  async function handleDelete() {
    const { error } = await supabase
      .from("contacts")
      .delete()
      .eq("id", contact.id);
    if (error) {
      toast.error("Failed to delete");
    } else {
      toast.success("Contact deleted");
      router.push("/board");
    }
  }

  async function handleAddTask() {
    if (!newTaskTitle.trim()) return;
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        user_id: userId,
        contact_id: contact.id,
        title: newTaskTitle.trim(),
        due_date: newTaskDue || null,
      })
      .select()
      .single();

    if (error) {
      toast.error("Failed to add task");
    } else {
      setTasks((prev) => [data as Task, ...prev]);
      setNewTaskTitle("");
      setNewTaskDue("");
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
      setTasks((prev) =>
        prev.map((t) =>
          t.id === taskId
            ? { ...t, is_done: true, completed_at: new Date().toISOString() }
            : t
        )
      );
    }
  }

  async function handleDeleteTask(taskId: string) {
    const { error } = await supabase.from("tasks").delete().eq("id", taskId);
    if (error) {
      toast.error("Failed to delete task");
    } else {
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    }
  }

  async function addTaskFromSuggestion(title: string) {
    const { data, error } = await supabase
      .from("tasks")
      .insert({
        user_id: userId,
        contact_id: contact.id,
        title,
      })
      .select()
      .single();

    if (error) {
      toast.error("Failed to add task");
    } else {
      setTasks((prev) => [data as Task, ...prev]);
      toast.success("Task added");
    }
  }

  const openTasks = tasks.filter((t) => !t.is_done);
  const completedTasks = tasks.filter((t) => t.is_done).slice(0, 5);

  return (
    <div className="flex flex-col h-[calc(100vh-3.5rem)]">
      <div className="border-b border-border/50 px-4 md:px-6 py-3 flex items-center gap-3 shrink-0">
        <Link
          href="/board"
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          Board
        </Link>
        <span className="text-muted-foreground/40">/</span>
        <span className="text-sm font-medium">{contact.name}</span>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden">
        {/* Left column — profile */}
        <div className="lg:w-[35%] border-b lg:border-b-0 lg:border-r border-border/50 overflow-y-auto p-4 md:p-6 space-y-6">
          <div>
            <h1 className="text-xl font-semibold">{contact.name}</h1>
            <div className="flex gap-1.5 mt-2">
              <Badge variant="secondary">{LOAN_TYPE_LABELS[contact.loan_type]}</Badge>
              <Badge variant="outline">{CRM_LABELS[contact.crm]}</Badge>
              <Badge variant="outline">{STAGE_LABELS[contact.stage]}</Badge>
            </div>
            {contact.bonzo_email && (
              <p className="text-sm text-muted-foreground mt-2">
                {contact.bonzo_email}
              </p>
            )}
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-medium">Edit Contact</h3>
            <div className="space-y-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">Loan Type</Label>
                <Select value={loanType} onValueChange={(v) => setLoanType(v as LoanType)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LOAN_TYPES.map((lt) => (
                      <SelectItem key={lt} value={lt}>{LOAN_TYPE_LABELS[lt]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">CRM</Label>
                <Select value={crm} onValueChange={(v) => setCrm(v as CRM)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CRM_OPTIONS.map((c) => (
                      <SelectItem key={c} value={c}>{CRM_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">Stage</Label>
              <Select value={stage} onValueChange={(v) => setStage(v as AllStages)}>
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ALL_STAGES.map((s) => (
                    <SelectItem key={s} value={s}>{STAGE_LABELS[s]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {stage === "adverse" && (
              <div className="space-y-1">
                <Label className="text-xs">Adverse Reason</Label>
                <Select value={adverseReason} onValueChange={(v) => setAdverseReason(v as AdverseReason)}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Select reason..." />
                  </SelectTrigger>
                  <SelectContent>
                    {ADVERSE_REASONS.map((r) => (
                      <SelectItem key={r} value={r}>{ADVERSE_REASON_LABELS[r]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Add notes..."
                rows={3}
                className="flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring resize-none"
              />
            </div>

            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving} className="flex-1">
                {saving ? "Saving..." : "Save"}
              </Button>
              {confirmDelete ? (
                <div className="flex gap-1">
                  <Button variant="destructive" size="sm" onClick={handleDelete}>
                    Delete
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setConfirmDelete(true)}>
                  <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              )}
            </div>
          </div>

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
                className="flex-1 h-8 text-xs"
              />
              <Input
                type="date"
                value={newTaskDue}
                onChange={(e) => setNewTaskDue(e.target.value)}
                className="w-[120px] h-8 text-xs"
              />
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                onClick={handleAddTask}
                disabled={!newTaskTitle.trim()}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            <div className="space-y-1.5">
              {openTasks.map((task) => (
                <div key={task.id} className="flex items-center gap-2 group">
                  <Checkbox onCheckedChange={() => handleCompleteTask(task.id)} />
                  <span className="text-xs flex-1">{task.title}</span>
                  {task.due_date && (
                    <span className="text-[10px] text-muted-foreground">
                      {new Date(task.due_date + "T00:00:00").toLocaleDateString("en-US", {
                        month: "short",
                        day: "numeric",
                      })}
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
                <p className="text-xs text-muted-foreground">No open tasks</p>
              )}
              {completedTasks.length > 0 && (
                <>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wider mt-3">
                    Recently completed
                  </p>
                  {completedTasks.map((task) => (
                    <div key={task.id} className="flex items-center gap-2">
                      <Checkbox checked disabled />
                      <span className="text-xs text-muted-foreground line-through">
                        {task.title}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </div>
          </div>
        </div>

        {/* Right column — insights */}
        <div className="lg:w-[65%] overflow-y-auto">
          <InsightsPanel
            contact={contact}
            existingTasks={tasks}
            onAddTask={addTaskFromSuggestion}
          />
        </div>
      </div>
    </div>
  );
}

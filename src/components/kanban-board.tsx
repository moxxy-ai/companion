"use client";

import { useEffect, useMemo, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { format } from "date-fns";
import {
  Calendar,
  CirclePlus,
  Filter,
  MoreHorizontal,
  Search,
  Sparkles,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { toast } from "sonner";
import {
  loadTasksFromIndexedDB,
  saveTasksToIndexedDB,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "@/lib/indexeddb";

const COLUMNS: { id: TaskStatus; title: string }[] = [
  { id: "todo", title: "Backlog" },
  { id: "in_progress", title: "In Progress" },
  { id: "review", title: "Review" },
  { id: "done", title: "Done" },
];

const priorityClass: Record<TaskPriority, string> = {
  low: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  high: "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30",
};

const initialTasks: Task[] = [
  {
    id: "1",
    title: "Design landing hero",
    description: "Craft premium hero section with subtle gradients and glassmorphism panels.",
    status: "todo",
    priority: "high",
    dueDate: new Date().toISOString(),
    tags: ["design", "marketing"],
  },
  {
    id: "2",
    title: "Build task creation flow",
    description: "Modal form with validation for title, priority, due date and tags.",
    status: "in_progress",
    priority: "medium",
    tags: ["frontend"],
  },
  {
    id: "3",
    title: "Persist board in local storage",
    description: "Hydrate and save state for smooth refresh experience.",
    status: "review",
    priority: "low",
    tags: ["state"],
  },
  {
    id: "4",
    title: "Prepare deployment checklist",
    description: "Run build, lint and write concise deployment notes for Vercel.",
    status: "done",
    priority: "medium",
    tags: ["devops"],
  },
];

function SortableTaskCard({
  task,
  onDelete,
}: {
  task: Task;
  onDelete: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: task.id, data: { type: "task", task } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`cursor-grab active:cursor-grabbing shadow-sm hover:shadow-md transition ${
        isDragging ? "opacity-40" : ""
      }`}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm leading-5">{task.title}</CardTitle>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7">
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                className="text-destructive"
                onClick={() => onDelete(task.id)}
              >
                <Trash2 className="mr-2 size-4" /> Delete
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground line-clamp-3">{task.description}</p>
        <div className="flex items-center justify-between">
          <Badge variant="outline" className={priorityClass[task.priority]}>
            {task.priority}
          </Badge>
          {task.dueDate ? (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="size-3" /> {format(new Date(task.dueDate), "MMM d")}
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

export default function KanbanBoard() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [isHydrated, setIsHydrated] = useState(false);
  const [activeTask, setActiveTask] = useState<Task | null>(null);
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState<"all" | TaskPriority>("all");
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    status: "todo" as TaskStatus,
    priority: "medium" as TaskPriority,
    dueDate: "",
    tags: "",
  });

  useEffect(() => {
    let mounted = true;

    async function hydrateTasks() {
      try {
        const persistedTasks = await loadTasksFromIndexedDB();
        if (!mounted) return;

        if (persistedTasks.length > 0) {
          setTasks(persistedTasks);
        } else {
          setTasks(initialTasks);
          await saveTasksToIndexedDB(initialTasks);
        }
      } catch {
        if (mounted) {
          setTasks(initialTasks);
          toast.error("Could not read offline data. Using default board data.");
        }
      } finally {
        if (mounted) setIsHydrated(true);
      }
    }

    hydrateTasks();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!isHydrated) return;

    saveTasksToIndexedDB(tasks).catch(() => {
      toast.error("Could not save offline board data.");
    });
  }, [tasks, isHydrated]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const filteredTasks = useMemo(() => {
    return tasks.filter((task) => {
      const matchesSearch = task.title.toLowerCase().includes(search.toLowerCase());
      const matchesPriority = priorityFilter === "all" ? true : task.priority === priorityFilter;
      return matchesSearch && matchesPriority;
    });
  }, [tasks, search, priorityFilter]);

  const tasksByColumn = useMemo(() => {
    return COLUMNS.reduce((acc, col) => {
      acc[col.id] = filteredTasks.filter((t) => t.status === col.id);
      return acc;
    }, {} as Record<TaskStatus, Task[]>);
  }, [filteredTasks]);

  function onDragStart(event: DragStartEvent) {
    const task = tasks.find((t) => t.id === event.active.id);
    if (task) setActiveTask(task);
  }

  function onDragEnd(event: DragEndEvent) {
    setActiveTask(null);
    const { active, over } = event;
    if (!over) return;

    const activeTask = tasks.find((t) => t.id === active.id);
    if (!activeTask) return;

    const overTask = tasks.find((t) => t.id === over.id);

    if (overTask) {
      if (activeTask.status !== overTask.status) {
        setTasks((prev) =>
          prev.map((t) => (t.id === activeTask.id ? { ...t, status: overTask.status } : t))
        );
      }

      const sameColumnTasks = tasks.filter((t) => t.status === overTask.status);
      const oldIndex = sameColumnTasks.findIndex((t) => t.id === activeTask.id);
      const newIndex = sameColumnTasks.findIndex((t) => t.id === overTask.id);

      if (oldIndex !== -1 && newIndex !== -1 && oldIndex !== newIndex) {
        const reordered = arrayMove(sameColumnTasks, oldIndex, newIndex);
        setTasks((prev) => {
          const untouched = prev.filter((t) => t.status !== overTask.status);
          return [...untouched, ...reordered];
        });
      }
      return;
    }

    const overColumn = COLUMNS.find((col) => col.id === over.id);
    if (overColumn) {
      setTasks((prev) =>
        prev.map((t) => (t.id === activeTask.id ? { ...t, status: overColumn.id } : t))
      );
    }
  }

  function addTask() {
    if (!form.title.trim()) {
      toast.error("Task title is required");
      return;
    }

    const newTask: Task = {
      id: crypto.randomUUID(),
      title: form.title.trim(),
      description: form.description.trim(),
      status: form.status,
      priority: form.priority,
      dueDate: form.dueDate || undefined,
      tags: form.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    };

    setTasks((prev) => [newTask, ...prev]);
    setForm({
      title: "",
      description: "",
      status: "todo",
      priority: "medium",
      dueDate: "",
      tags: "",
    });
    setOpen(false);
    toast.success("Task created");
  }

  function deleteTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    toast.success("Task removed");
  }

  return (
    <div className="min-h-screen bg-[radial-gradient(circle_at_top,_var(--color-primary)/8,_transparent_40%),linear-gradient(to_bottom_right,var(--color-background),color-mix(in_oklch,var(--color-background),black_4%))]">
      <div className="mx-auto max-w-[1400px] p-4 md:p-8 space-y-6">
        <header className="rounded-3xl border bg-card/70 backdrop-blur p-5 md:p-7 shadow-sm">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <div className="inline-flex items-center gap-2 text-xs text-muted-foreground mb-2">
                <Sparkles className="size-3.5" /> Premium Workflow
              </div>
              <h1 className="text-2xl md:text-3xl font-semibold tracking-tight">TaskFlow Kanban</h1>
              <p className="text-sm text-muted-foreground mt-1">A classy modern board for your team's daily execution.</p>
            </div>

            <Dialog open={open} onOpenChange={setOpen}>
              <DialogTrigger asChild>
                <Button className="rounded-2xl"><CirclePlus className="size-4" /> New Task</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Create task</DialogTitle>
                  <DialogDescription>Add a new task to your Kanban workflow.</DialogDescription>
                </DialogHeader>

                <div className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>Title</Label>
                    <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Description</Label>
                    <Textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Status</Label>
                      <Select value={form.status} onValueChange={(v: TaskStatus) => setForm((f) => ({ ...f, status: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {COLUMNS.map((c) => <SelectItem key={c.id} value={c.id}>{c.title}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label>Priority</Label>
                      <Select value={form.priority} onValueChange={(v: TaskPriority) => setForm((f) => ({ ...f, priority: v }))}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="low">Low</SelectItem>
                          <SelectItem value="medium">Medium</SelectItem>
                          <SelectItem value="high">High</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Due date</Label>
                      <Input type="date" value={form.dueDate} onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Tags (comma separated)</Label>
                      <Input value={form.tags} onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))} placeholder="frontend, ui" />
                    </div>
                  </div>
                </div>

                <DialogFooter>
                  <Button onClick={addTask}>Create</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <Separator className="my-5" />

          <div className="flex flex-col md:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
              <Input className="pl-9" placeholder="Search tasks..." value={search} onChange={(e) => setSearch(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" className="rounded-xl"><Filter className="size-4" /> Filter</Button>
              <Select value={priorityFilter} onValueChange={(v: "all" | TaskPriority) => setPriorityFilter(v)}>
                <SelectTrigger className="w-[170px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All priorities</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </header>

        <DndContext sensors={sensors} onDragStart={onDragStart} onDragEnd={onDragEnd}>
          <div className="grid gap-4 lg:grid-cols-4">
            {COLUMNS.map((column) => (
              <Card key={column.id} className="rounded-3xl border shadow-sm bg-card/80 backdrop-blur-sm">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{column.title}</CardTitle>
                    <Badge variant="secondary">{tasksByColumn[column.id]?.length ?? 0}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <ScrollArea className="h-[calc(100vh-360px)] pr-3">
                    <SortableContext
                      items={(tasksByColumn[column.id] || []).map((task) => task.id)}
                      strategy={verticalListSortingStrategy}
                    >
                      <div id={column.id} className="space-y-3 min-h-24">
                        {(tasksByColumn[column.id] || []).map((task) => (
                          <SortableTaskCard key={task.id} task={task} onDelete={deleteTask} />
                        ))}
                      </div>
                    </SortableContext>
                  </ScrollArea>
                </CardContent>
              </Card>
            ))}
          </div>

          <DragOverlay>
            {activeTask ? <SortableTaskCard task={activeTask} onDelete={() => {}} /> : null}
          </DragOverlay>
        </DndContext>
      </div>
    </div>
  );
}

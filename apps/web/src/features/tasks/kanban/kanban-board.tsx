import { useCallback, useMemo } from 'react';
import {
  DndContext,
  DragOverlay,
  closestCorners,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { KanbanColumn } from './kanban-column';
import { TaskCard } from './task-card';
import { COLUMNS, getStatusesForColumn } from './column-config';
import type { Task, TaskStatus } from '../types';

interface KanbanBoardProps {
  tasks: Task[];
  onReorder: (taskId: string, newStatus: string) => void;
  onTaskClick: (taskId: string) => void;
  loading?: boolean;
}

export function KanbanBoard({ tasks, onReorder, onTaskClick, loading }: KanbanBoardProps) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Group tasks by column
  const columnTasks = useMemo(() => {
    const map = new Map<string, Task[]>();
    const now = new Date();

    for (const col of COLUMNS) {
      let colTasks: Task[];
      if (col.id === 'overdue') {
        // Overdue = past due date AND not completed/cancelled/skipped
        colTasks = tasks.filter(
          (t) =>
            t.dueDate &&
            new Date(t.dueDate) < now &&
            t.status !== 'COMPLETED' &&
            t.status !== 'CANCELLED' &&
            t.status !== 'SKIPPED',
        );
      } else {
        colTasks = tasks.filter((t) => col.statuses.includes(t.status as TaskStatus));
      }
      map.set(col.id, colTasks);
    }
    return map;
  }, [tasks]);

  // Track which task is being dragged (for overlay)
  const activeTask = useMemo(() => {
    // We track this via drag events but dnd-kit stores it internally
    return null;
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over) return;

      const taskId = active.id as string;
      const targetColumnId = over.id as string;

      // If over a column or another card in a column, find target status
      const targetCol = COLUMNS.find(
        (c) => c.id === targetColumnId || c.statuses.some((s) => columnTasks.get(c.id)?.some((t) => t.id === targetColumnId)),
      );
      if (!targetCol) return;
      if (targetCol.id === 'overdue') return;

      const targetStatus = targetCol.statuses[0];
      if (!targetStatus) return;

      // Find the task's current column to see if status actually changed
      const currentCol = COLUMNS.find((c) =>
        c.statuses.includes(
          tasks.find((t) => t.id === taskId)?.status as TaskStatus,
        ),
      );

      if (currentCol?.id !== targetCol.id) {
        onReorder(taskId, targetStatus);
      }
    },
    [tasks, onReorder, columnTasks],
  );

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.filter((c) => c.id !== 'overdue').map((col) => (
          <div key={col.id} className="flex w-72 shrink-0 flex-col gap-2">
            <div className="h-8 w-24 animate-pulse rounded bg-muted" />
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-lg bg-muted" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragEnd={handleDragEnd}
    >
      <div className="flex gap-3 overflow-x-auto pb-4">
        {COLUMNS.map((col) => (
          <KanbanColumn
            key={col.id}
            column={col}
            tasks={columnTasks.get(col.id) ?? []}
            onTaskClick={onTaskClick}
          />
        ))}
      </div>

      <DragOverlay>
        {activeTask ? null : null}
      </DragOverlay>
    </DndContext>
  );
}

# Task Management Kanban System — Implementation Plan

> **For Hermes/OpenCode:** Execute this plan task-by-task using OpenCode CLI. Each task is bite-sized (2-10 min), with exact file paths and complete code patterns.

**Goal:** Build a production-grade Task Management Module (Kanban + List + Calendar + Dashboard) for a multi-branch POS system serving cafes, restaurants, retail stores, supermarkets, bakeries, pharmacies, hotels, and convenience stores.

**Architecture:** NestJS module (`TaskModule`) with Prisma-backed data layer, REST API, event-driven auto-generation, and offline-first sync. React frontend with Kanban board (drag & drop), list view, calendar view, task drawer, and dashboard.

**Tech Stack:**
- Backend: NestJS 11 + Prisma 6 + PostgreSQL (same patterns as `PosModule`)
- Frontend: React 18 + TypeScript + Tailwind CSS + Zustand + React Query + `@dnd-kit` for Kanban + Radix UI + Recharts
- State: Zustand store for offline queue + React Query for server data
- Sync: Existing SyncModule pattern (offline-first with background sync)

---

## Phase 0: Database Schema & Enums

### Task 0.1: Add Prisma Enums for Task Management

**Objective:** Define all enum types needed for the task module.

**Files:** Modify `apps/api/prisma/schema.prisma` (add enums near existing enums around line 100)

Add these enums to the schema file after the existing `AuditAction` enum:

```prisma
// =============================================================================
// Task Management Module — Enums
// =============================================================================

enum TaskType {
  ONE_TIME
  RECURRING
  SHIFT
  OPENING
  CLOSING
  CLEANING
  MAINTENANCE
  INVENTORY
  AUDIT
  PURCHASE
  INCIDENT
  COMPLIANCE
  FOOD_SAFETY
  EQUIPMENT_INSPECTION
  CUSTOM
}

enum TaskPriority {
  CRITICAL
  HIGH
  MEDIUM
  LOW
  OPTIONAL
}

enum TaskStatus {
  DRAFT
  PENDING
  ASSIGNED
  IN_PROGRESS
  WAITING
  REVIEW
  VERIFIED
  COMPLETED
  CANCELLED
  SKIPPED
  OVERDUE
}

enum TaskCategory {
  OPENING
  CLOSING
  CLEANING
  KITCHEN
  COFFEE_BAR
  DINING_AREA
  RETAIL_FLOOR
  WAREHOUSE
  INVENTORY
  PURCHASING
  ACCOUNTING
  CASH_MANAGEMENT
  SECURITY
  MAINTENANCE
  EQUIPMENT
  MARKETING
  COMPLIANCE
  AUDIT
  CUSTOMER_SERVICE
  CUSTOM
}

enum TaskArea {
  KITCHEN
  COFFEE_STATION
  BAR
  DINING_AREA
  RETAIL_FLOOR
  WAREHOUSE
  OFFICE
  CASHIER
  STORAGE
  DELIVERY
  RESTROOM
  PARKING
  OTHER
}

enum RecurrenceType {
  HOURLY
  EVERY_X_HOURS
  DAILY
  WEEKDAYS
  WEEKENDS
  WEEKLY
  MONTHLY
  QUARTERLY
  YEARLY
  CUSTOM_DATES
  SPECIFIC_SHIFT
  AFTER_COMPLETION
}

enum TaskNotificationChannel {
  IN_APP
  PUSH
  SMS
  EMAIL
  WHATSAPP
  TELEGRAM
}

enum VerificationMethod {
  MANAGER_PIN
  PASSWORD
  BIOMETRIC
  DIGITAL_SIGNATURE
  PHOTO_PROOF
}
```

### Task 0.2: Add Task Model

**Objective:** Create the core `Task` model in the Prisma schema.

**Files:** Modify `apps/api/prisma/schema.prisma` (add after the `PosReportSnapshot` model or in a logical location)

```prisma
// =============================================================================
// Task Management Module — Core Models
// =============================================================================

/// A task in the operational task management system.
model Task {
  id               String          @id @default(uuid())
  organizationId   String
  branchId         String?
  title            String
  description      String?
  taskType         TaskType        @default(ONE_TIME)
  priority         TaskPriority    @default(MEDIUM)
  status           TaskStatus      @default(PENDING)
  category         TaskCategory?   @default(CUSTOM)
  area             TaskArea?
  departmentId     String?
  
  // Assignment
  assignedToId     String?         // User ID
  assignedRole     String?         // Role name
  supervisorId     String?         // Supervisor User ID
  
  // Timing
  dueDate          DateTime?
  dueTime          String?         // HH:mm (time-of-day component)
  startTime        DateTime?
  completedAt      DateTime?
  estimatedMinutes Int?
  actualMinutes    Int?
  
  // Recurrence
  isRecurring      Boolean         @default(false)
  recurrenceType   RecurrenceType?
  recurrenceConfig Json?           // { interval: 2, daysOfWeek: [1,2,3], cronExpression: "0 8 * * *", ... }
  parentTaskId     String?         // For recurring instances
  recurrenceOrder  Int?            // Which instance in the series
  
  // Verification
  requiresVerification Boolean     @default(false)
  verificationMethod    VerificationMethod?
  verifiedById      String?
  verifiedAt        DateTime?
  verificationPhoto String?
  verificationNote  String?
  
  // Details
  checklistProgress Int             @default(0) // percentage 0-100
  checklistTotal    Int             @default(0)
  photoUrls         String[]        @default([])
  attachmentUrls    String[]        @default([])
  
  // Source
  generatedByEvent  String?         // Which event auto-generated this (e.g. "inventory_below_reorder")
  sourceReferenceId String?         // Related entity ID (e.g. Product ID, PurchaseOrder ID)
  sourceReferenceType String?       // "product", "purchase_order", "equipment", etc.
  
  // Shift association
  shiftId           String?         // Links to POS shift
  
  // Standard columns
  createdAt         DateTime        @default(now())
  updatedAt         DateTime        @updatedAt
  createdBy         String?
  updatedBy         String?
  deletedAt         DateTime?
  
  // Relations
  branch            Branch?         @relation(fields: [branchId], references: [id])
  assignedTo        User?           @relation("TaskAssignee", fields: [assignedToId], references: [id])
  supervisor        User?           @relation("TaskSupervisor", fields: [supervisorId], references: [id])
  verifiedBy        User?           @relation("TaskVerifier", fields: [verifiedById], references: [id])
  parentTask        Task?           @relation("TaskRecurrence", fields: [parentTaskId], references: [id])
  children          Task[]          @relation("TaskRecurrence")
  checklistItems    TaskChecklistItem[]
  comments          TaskComment[]
  activityLog       TaskActivityLog[]
  labels            TaskLabel[]     @relation("TaskLabelLink")
  
  @@index([organizationId])
  @@index([organizationId, status])
  @@index([organizationId, assignedToId])
  @@index([organizationId, branchId])
  @@index([organizationId, dueDate])
  @@index([organizationId, priority])
  @@index([organizationId, createdBy])
  @@index([organizationId, shiftId])
  @@index([organizationId, taskType])
  @@index([organizationId, category])
}

/// Checklist item within a task.
model TaskChecklistItem {
  id             String   @id @default(uuid())
  organizationId String
  taskId         String
  description    String
  isCompleted    Boolean  @default(false)
  completedAt    DateTime?
  completedBy    String?  // User ID
  sortOrder      Int      @default(0)
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId])
  @@index([organizationId])
}

/// Threaded comments on tasks.
model TaskComment {
  id             String   @id @default(uuid())
  organizationId String
  taskId         String
  parentId       String?  // For threaded replies
  content        String
  mentions       String[] @default([]) // User IDs mentioned
  attachmentUrls String[] @default([])
  emojiReactions Json?    // { "👍": ["user1", "user2"], "🚀": ["user3"] }
  createdById    String
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
  deletedAt      DateTime?

  task   Task  @relation(fields: [taskId], references: [id], onDelete: Cascade)
  parent TaskComment? @relation("CommentThread", fields: [parentId], references: [id])
  replies TaskComment[] @relation("CommentThread")

  @@index([taskId])
  @@index([organizationId])
}

/// Activity timeline for task changes.
model TaskActivityLog {
  id             String   @id @default(uuid())
  organizationId String
  taskId         String
  action         String   // "created", "assigned", "status_changed", "commented", "checklist_updated", "verified", etc.
  field          String?  // Which field changed (for "status_changed" -> "status")
  oldValue       String?
  newValue       String?
  description    String?
  createdById    String
  createdAt      DateTime @default(now())

  task Task @relation(fields: [taskId], references: [id], onDelete: Cascade)

  @@index([taskId])
  @@index([organizationId])
}

/// Labels/tags that can be applied to tasks.
model TaskLabel {
  id             String   @id @default(uuid())
  organizationId String
  name           String
  color          String   @default("#6366f1") // hex color
  createdAt      DateTime @default(now())

  tasks Task[] @relation("TaskLabelLink")

  @@unique([organizationId, name])
  @@index([organizationId])
}

/// Auto-generation rules for tasks.
model TaskAutoRule {
  id               String   @id @default(uuid())
  organizationId   String
  name             String
  description      String?
  triggerEvent     String   // "inventory_below_reorder", "supplier_delivery", "printer_offline", etc.
  triggerConfig    Json?    // { productId: "...", threshold: 10 } — config per trigger
  taskTitle        String   // Template: "Restock {productName}"
  taskDescription  String?  // Template: "{productName} is below reorder level ({currentQty} < {minQty})"
  taskType         TaskType
  taskCategory     TaskCategory?
  taskArea         TaskArea?
  taskPriority     TaskPriority  @default(MEDIUM)
  assignToRole     String?
  assignToUserId   String?
  branchId         String?
  requiresVerification Boolean @default(false)
  isActive         Boolean  @default(true)
  createdAt        DateTime @default(now())
  updatedAt        DateTime @updatedAt
  createdBy        String?
  updatedBy        String?

  @@index([organizationId])
  @@index([organizationId, triggerEvent])
}

/// Recurring task template (for recurring task type).
model TaskRecurringTemplate {
  id               String          @id @default(uuid())
  organizationId   String
  title            String
  description      String?
  taskType         TaskType        @default(RECURRING)
  taskCategory     TaskCategory?
  taskArea         TaskArea?
  priority         TaskPriority    @default(MEDIUM)
  recurrenceType   RecurrenceType  @default(DAILY)
  recurrenceConfig Json?           // { interval: 2, time: "08:00", daysOfWeek: [1,2,3,4,5], cronExpression: "0 8 * * 1-5" }
  estimatedMinutes Int?
  requiresVerification Boolean     @default(false)
  verificationMethod    VerificationMethod?
  branchId          String?
  departmentId      String?
  assignToRole      String?
  assignToUserId    String?
  supervisorId      String?
  checklistTemplate Json?          // [ { description: "Count cash", sortOrder: 0 }, ... ]
  isActive          Boolean        @default(true)
  createdAt         DateTime       @default(now())
  updatedAt         DateTime       @updatedAt
  createdBy         String?
  updatedBy         String?
  deletedAt         DateTime?

  @@index([organizationId])
}
```

### Task 0.3: Generate & Apply Prisma Migration

**Objective:** Create and run the Prisma migration.

**Commands:**
```bash
cd /c/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api
npx prisma migrate dev --name add-task-management --create-only
npx prisma migrate deploy
npx prisma generate
```

**Verify:** `npx prisma db push` exits 0, no schema errors.

---

## Phase 1: Backend NestJS Module

### Task 1.1: Create TaskModule NestJS Skeleton

**Objective:** Create the NestJS module, controller, service, and DTO files following the existing POS module pattern.

**Files to Create:**
- `apps/api/src/modules/task/task.module.ts`
- `apps/api/src/modules/task/task.controller.ts`
- `apps/api/src/modules/task/task.service.ts`
- `apps/api/src/modules/task/dto/create-task.dto.ts`
- `apps/api/src/modules/task/dto/update-task.dto.ts`
- `apps/api/src/modules/task/dto/task-query.dto.ts`
- `apps/api/src/modules/task/dto/reorder-task.dto.ts`

**Pattern to follow** (from POS module): each service uses `PrismaService` (injected via `@Inject(PrismaService)`), returns typed responses, uses `class-validator` + `class-transformer` decorators on DTOs.

**`task.module.ts`:**
```typescript
import { Module } from '@nestjs/common';
import { TaskController } from './task.controller';
import { TaskService } from './task.service';

@Module({
  controllers: [TaskController],
  providers: [TaskService],
  exports: [TaskService],
})
export class TaskModule {}
```

**`task.controller.ts` (key endpoints):**
- `GET /tasks` — list with filters (status, assignee, branch, category, priority, date range, search, pagination)
- `GET /tasks/:id` — get single task with relations
- `POST /tasks` — create task
- `PATCH /tasks/:id` — update task (partial)
- `DELETE /tasks/:id` — soft delete
- `PATCH /tasks/:id/reorder` — drag-drop reorder (update status + position)
- `PATCH /tasks/:id/checklist/:itemId` — toggle checklist item
- `POST /tasks/:id/comments` — add comment
- `POST /tasks/:id/verify` — verify task
- `GET /tasks/dashboard` — KPI dashboard stats
- `GET /tasks/templates` — recurring templates
- `POST /tasks/templates` — create template
- `GET /tasks/labels` — list labels
- `POST /tasks/labels` — create label
- `GET /tasks/auto-rules` — auto-generation rules
- `POST /tasks/auto-rules` — create auto-rule

### Task 1.2: Implement TaskService Core Methods

**Objective:** Implement CRUD + query + reorder + checklist in `task.service.ts`.

**Key features:**
- Multi-tenant filter scoped by `organizationId` (follows existing pattern using `PrismaService` with tenant context)
- Soft-delete pattern (`deletedAt: null` default filter)
- Auto-update `checklistProgress`/`checklistTotal` on checklist toggle
- Activity log on status/assignment changes
- Recurring task instance generation via `@nestjs/schedule` cron

**File:** `apps/api/src/modules/task/task.service.ts`

### Task 1.3: Implement Task Dashboard & Filtering

**Objective:** Build aggregation queries for KPI dashboard and advanced filtering.

**KPI Queries:**
- Today's tasks count
- Completed today
- Pending
- In Progress
- Overdue
- Due Today
- Recurring Today
- Verification Pending
- Completion Rate (percentage)
- Average Completion Time
- Top Employees by completion

**Filtering:**
- Combine status, priority, category, area, branch, assignee, date range, search term
- Pagination with cursor or offset

### Task 1.4: Implement Recurring Task Generation (Cron)

**Objective:** Use `@nestjs/schedule` to generate recurring task instances.

**Logic:**
- Every hour, check `TaskRecurringTemplate` where `isActive = true`
- For each template, check if an instance should be generated based on `recurrenceType` + `recurrenceConfig`
- Create `Task` records with `isRecurring = true`, `parentTaskId = null`
- Respect branch/timezone settings

**File:** Create `apps/api/src/modules/task/task-scheduler.service.ts`

### Task 1.5: Register TaskModule in AppModule

**Objective:** Wire the TaskModule into the application and add sidebar navigation.

**Files:** Modify `apps/api/src/app.module.ts` — add `TaskModule` import.

Add route to app shell sidebar in `apps/web/src/components/layout/app-shell.tsx`.

---

## Phase 2: Frontend — Shared Components & State

### Task 2.1: Install DnD Dependencies

**Objective:** Install `@dnd-kit/core`, `@dnd-kit/sortable`, `@dnd-kit/utilities` for Kanban drag-and-drop.

**Command:**
```bash
cd /c/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/web
npm install @dnd-kit/core @dnd-kit/sortable @dnd-kit/utilities @dnd-kit/accessory
```

### Task 2.2: Create Task Types & Zod Schemas

**Objective:** Define TypeScript types and Zod validation schemas shared between components.

**File to Create:** `apps/web/src/features/tasks/types.ts`

```typescript
export enum TaskType { ONE_TIME = 'ONE_TIME', RECURRING = 'RECURRING', SHIFT = 'SHIFT', /* ... */ }
export enum TaskPriority { CRITICAL = 'CRITICAL', HIGH = 'HIGH', MEDIUM = 'MEDIUM', LOW = 'LOW', OPTIONAL = 'OPTIONAL' }
export enum TaskStatus { DRAFT = 'DRAFT', /* ... all statuses */ }
export enum TaskCategory { OPENING = 'OPENING', /* ... */ }
export enum TaskArea { KITCHEN = 'KITCHEN', /* ... */ }

export interface TaskLabel {
  id: string; name: string; color: string;
}

export interface TaskChecklistItem {
  id: string; taskId: string; description: string; isCompleted: boolean;
  completedAt: string | null; completedBy: string | null; sortOrder: number;
}

export interface TaskComment {
  id: string; taskId: string; parentId: string | null;
  content: string; mentions: string[]; attachmentUrls: string[];
  emojiReactions: Record<string, string[]> | null;
  createdById: string; createdAt: string;
  replies?: TaskComment[];
}

export interface Task {
  id: string; organizationId: string; branchId: string | null;
  title: string; description: string | null;
  taskType: TaskType; priority: TaskPriority; status: TaskStatus;
  category: TaskCategory | null; area: TaskArea | null;
  assignedToId: string | null; supervisorId: string | null;
  dueDate: string | null; dueTime: string | null;
  completedAt: string | null;
  estimatedMinutes: number | null; actualMinutes: number | null;
  isRecurring: boolean; recurrenceType: string | null;
  requiresVerification: boolean;
  checklistProgress: number; checklistTotal: number;
  photoUrls: string[]; attachmentUrls: string[];
  createdAt: string; updatedAt: string;
  labels: TaskLabel[];
  checklistItems: TaskChecklistItem[];
  comments?: TaskComment[];
  activityLog?: TaskActivityLog[];
  // Joined
  assignedTo?: { id: string; firstName: string; lastName: string | null; };
  supervisor?: { id: string; firstName: string; lastName: string | null; };
  branch?: { id: string; name: string; };
}
```

### Task 2.3: Create Task Zustand Store

**Objective:** Build an offline-first store for task state management.

**File to Create:** `apps/web/src/features/tasks/task.store.ts`

```typescript
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface TaskFilters {
  status?: string[];
  priority?: string[];
  category?: string;
  area?: string;
  branchId?: string;
  assignedToId?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  view: 'kanban' | 'list' | 'calendar' | 'timeline';
}

interface TaskStoreState {
  filters: TaskFilters;
  selectedTaskId: string | null;
  drawerOpen: boolean;
  // Offline queue
  offlineQueue: { action: string; payload: unknown; timestamp: number }[];
  setFilters: (filters: Partial<TaskFilters>) => void;
  resetFilters: () => void;
  openDrawer: (taskId: string) => void;
  closeDrawer: () => void;
  addToQueue: (action: string, payload: unknown) => void;
  clearQueue: () => void;
}
```

### Task 2.4: Create Task API Module

**Objective:** React Query hooks for all task API operations.

**File to Create:** `apps/web/src/features/tasks/api.ts`

Includes:
- `useTasks(filters)` — query with filters
- `useTask(id)` — single task
- `useCreateTask()` — mutation
- `useUpdateTask()` — mutation
- `useReorderTask()` — mutation for drag-drop
- `useToggleChecklist()` — mutation
- `useAddComment()` — mutation
- `useVerifyTask()` — mutation
- `useTaskDashboard()` — KPI query
- `useTaskLabels()` / `useCreateLabel()`

---

## Phase 3: Frontend — Kanban Board

### Task 3.1: Build KanbanColumn Component

**Objective:** A single Kanban column that accepts draggable task cards.

**File to Create:** `apps/web/src/features/tasks/kanban/kanban-column.tsx`

**Features:**
- Column header with status name + task count + color indicator
- Uses `useDroppable` from `@dnd-kit/core`
- Scrollable card list
- Empty state when no tasks
- Collapsible for mobile

### Task 3.2: Build TaskCard Component

**Objective:** A draggable task card for the Kanban board.

**File to Create:** `apps/web/src/features/tasks/kanban/task-card.tsx`

**Card content:**
- Priority color strip (left border)
- Icon based on task type
- Title (truncated to 2 lines)
- Due date/time with overdue highlighting
- Assigned employee avatar/initials
- Area badge
- Checklist progress bar (if has items)
- Recurring icon (if recurring)
- Attachments/photo indicator (count)
- Comments count
- Labels as colored dots/badges
- Estimated duration
- Click to open task drawer

### Task 3.3: Build KanbanBoard Component

**Objective:** The full Kanban board with columns and drag-drop.

**File to Create:** `apps/web/src/features/tasks/kanban/kanban-board.tsx`

**Features:**
- Uses `DndContext` from `@dnd-kit/core`
- Horizontal scroll with sticky columns
- Columns: TODO → ASSIGNED → IN_PROGRESS → WAITING → REVIEW → VERIFIED → COMPLETED → CANCELLED → OVERDUE
- Drag overlay (ghost card following cursor)
- `onDragEnd` handler → call reorder API
- Loading skeleton state
- Empty state per column
- Horizon scroll on mobile

### Task 3.4: Build Column Config

**Objective:** Centralize column definitions with colors and status mappings.

**File to Create:** `apps/web/src/features/tasks/kanban/column-config.ts`

```typescript
export interface ColumnDef {
  id: TaskStatus;
  title: string;
  color: string;        // Tailwind class
  dotColor: string;     // hex for inline style
  accepts: TaskStatus[]; // which statuses this column shows
}

export const COLUMNS: ColumnDef[] = [
  { id: 'TODO', title: 'To Do', color: 'bg-slate-400', dotColor: '#94a3b8', accepts: ['DRAFT', 'PENDING'] },
  { id: 'ASSIGNED', title: 'Assigned', color: 'bg-blue-500', dotColor: '#3b82f6', accepts: ['ASSIGNED'] },
  { id: 'IN_PROGRESS', title: 'In Progress', color: 'bg-amber-500', dotColor: '#f59e0b', accepts: ['IN_PROGRESS'] },
  { id: 'WAITING', title: 'Waiting', color: 'bg-purple-500', dotColor: '#a855f7', accepts: ['WAITING'] },
  { id: 'REVIEW', title: 'Review', color: 'bg-orange-500', dotColor: '#f97316', accepts: ['REVIEW'] },
  { id: 'VERIFIED', title: 'Verified', color: 'bg-teal-500', dotColor: '#14b8a6', accepts: ['VERIFIED'] },
  { id: 'COMPLETED', title: 'Completed', color: 'bg-emerald-500', dotColor: '#10b981', accepts: ['COMPLETED'] },
  { id: 'CANCELLED', title: 'Cancelled', color: 'bg-red-400', dotColor: '#f87171', accepts: ['CANCELLED', 'SKIPPED'] },
  { id: 'OVERDUE', title: 'Overdue', color: 'bg-red-600', dotColor: '#dc2626', accepts: [], // computed filter },
];
```

---

## Phase 4: Frontend — Additional Views

### Task 4.1: Build List View

**Objective:** Professional table/List view alternative to Kanban.

**File to Create:** `apps/web/src/features/tasks/list/task-list-view.tsx`

**Columns:** Task, Category, Branch, Area, Assigned To, Priority, Status, Due Date, Repeat, Shift, Progress, Last Updated, Actions.

**Features:**
- Uses existing `DataTable` component
- Sortable columns
- Row click → open drawer
- Bulk actions (select multiple → assign, change status)
- Export to CSV

### Task 4.2: Build Calendar View

**Objective:** Calendar view showing tasks by due date.

**File to Create:** `apps/web/src/features/tasks/calendar/task-calendar-view.tsx`

**Features:**
- Month/week/day views
- Tasks shown as color-coded cards on their due date
- Click to open drawer
- Drag to reschedule
- Filter by status/assignee
- Today marker

### Task 4.3: Build Task Drawer

**Objective:** Side drawer with full task details.

**File to Create:** `apps/web/src/features/tasks/drawer/task-drawer.tsx`

**Sections:**
- Header: title, status badge, priority, type icon
- Description (rich text area)
- Metadata grid: Branch, Area, Department, Category, Assigned To, Supervisor, Due Date/Time, Duration
- Recurrence info
- Checklist with toggle + add item
- Attachments (photos, files) with upload
- Comments (threaded, with @mentions, emoji reactions)
- Activity timeline
- Verification section (if required)
- Audit log

### Task 4.4: Build Task Create/Edit Dialog

**Objective:** Modal for creating and editing tasks.

**File to Create:** `apps/web/src/features/tasks/dialogs/task-form-dialog.tsx`

**Form sections:**
- Title + Description
- Task Type + Category + Area
- Priority + Status
- Branch + Department + Assignment (user/role)
- Supervisor
- Due date/time + Estimated duration
- Recurrence settings
- Checklist items (dynamic add/remove)
- Labels (multi-select with color)
- Verification requirements
- Photo/file attachments

---

## Phase 5: Frontend — Dashboard & Reports

### Task 5.1: Build Task Dashboard

**Objective:** KPI dashboard with charts and stats.

**File to Create:** `apps/web/src/features/tasks/dashboard/task-dashboard.tsx`

**KPI Cards:**
- Today's Tasks (total count)
- Completed (green, with trend)
- Pending (amber)
- In Progress (blue)
- Overdue (red, with count)
- Due Today
- Recurring Today
- Verification Pending
- Completion Rate (percentage chart)
- Average Completion Time

**Charts (Recharts):**
- Tasks by status (pie/donut)
- Tasks completed this week (bar)
- Overdue by category (horizontal bar)
- Employee productivity (bar)

### Task 5.2: Build Task Reports Page

**Objective:** Generate reports with export options.

**File to Create:** `apps/web/src/features/tasks/reports/task-reports.tsx`

**Report Types:**
- Task Completion Report
- Employee Productivity Report
- Overdue Tasks Report
- Cleaning Compliance Report
- Equipment Maintenance Report
- Branch Comparison Report

**Export:** CSV, PDF

---

## Phase 6: Auto-Generation & Notification

### Task 6.1: Implement Event-Driven Task Generation

**Objective:** Auto-generate tasks when events occur in other modules.

**File:** `apps/api/src/modules/task/task-auto-generator.service.ts`

**Listen to events (using `@nestjs/event-emitter`):**
- `inventory.below_reorder` → Create "Restock Product" task
- `purchase.delivery_arrived` → Create "Verify Delivery" task
- `printer.offline` → Create "Replace Paper" task
- `cash.mismatch` → Create "Verify Cash" task
- `customer.complaint` → Create "Follow Up" task
- `equipment.service_due` → Create "Schedule Maintenance" task
- `fridge.temperature_exceeded` → Create "Inspect Fridge" task (critical priority)

**Lookup `TaskAutoRule` matching the `triggerEvent`, create task per configuration.**

### Task 6.2: Implement Notifications

**Objective:** Send notifications when tasks are assigned, due, overdue, or completed.

**File:** `apps/api/src/modules/task/task-notification.service.ts`

**Channels (using existing notification infrastructure):**
- In-app (via existing `NotificationsBell`)
- Push (via existing web-push setup)
- Email (via existing nodemailer)

**Triggers:**
- Task Assigned → notify assignee
- Task Due (within 1 hour) → notify assignee
- Task Overdue → notify assignee + supervisor
- Task Completed (requires verification) → notify supervisor
- Task Verified → notify assignee

---

## Phase 7: Frontend Pages & Routing

### Task 7.1: Create Task Pages

**Files to Create:**
- `apps/web/src/pages/tasks/TasksKanbanPage.tsx` — Kanban view page
- `apps/web/src/pages/tasks/TasksListViewPage.tsx` — List view page
- `apps/web/src/pages/tasks/TasksCalendarPage.tsx` — Calendar view page
- `apps/web/src/pages/tasks/TasksDashboardPage.tsx` — Dashboard page
- `apps/web/src/pages/tasks/TaskReportsPage.tsx` — Reports page
- `apps/web/src/pages/tasks/TaskSettingsPage.tsx` — Auto-rules + labels + templates settings

### Task 7.2: Add Routes & Navigation

**Modify:** `apps/web/src/App.tsx` — add task routes
**Modify:** `apps/web/src/components/layout/app-shell.tsx` — add task nav items

Routes:
- `/tasks` → Kanban Board (default)
- `/tasks/kanban` → Kanban Board
- `/tasks/list` → List View
- `/tasks/calendar` → Calendar View
- `/tasks/dashboard` → Dashboard
- `/tasks/reports` → Reports
- `/tasks/settings` → Auto-rules & Labels & Templates

### Task 7.3: Add View Switcher

**Objective:** Tabs/toggle between Kanban, List, Calendar, Dashboard views.

**File to Create:** `apps/web/src/features/tasks/task-view-switcher.tsx`

---

## Phase 8: Offline Support

### Task 8.1: Implement Offline Queue

**Objective:** Use the existing SyncModule pattern for offline-first task operations.

**Modify:** `apps/web/src/features/tasks/task.store.ts` — add pending sync queue
**File:** `apps/web/src/features/tasks/task-sync.service.ts` — background sync when online

**Pattern:**
- Operations queued in IndexedDB (via `idb-keyval`, already in project)
- When online, drain queue → POST/PATCH to API
- Conflict resolution: last-write-wins + server timestamp check

---

## Verification & Testing

### Task V.1: Backend Smoke Tests

```bash
# Start API server
cd /c/Users/Simon/OneDrive/Documents/GitHub/POS-CAFE/apps/api
npx nest start &

# Test CRUD
curl -X POST http://localhost:3001/tasks \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"title":"Test task","priority":"HIGH"}'

curl http://localhost:3001/tasks?status=PENDING

curl -X PATCH http://localhost:3001/tasks/$ID/reorder \
  -H "Content-Type: application/json" \
  -d '{"status":"IN_PROGRESS"}'
```

### Task V.2: Frontend Verification

- Kanban renders 9 columns
- Drag card from TODO to IN_PROGRESS → API called, card moves
- List view shows all tasks with sortable columns
- Calendar view shows tasks on dates
- Dashboard shows KPIs
- Task drawer opens on click
- Create task form submits correctly
- Checklist items toggle
- Comments post and appear
- Offline queue stores pending changes

---

## Risks & Open Questions

1. **Migration backward compatibility** — Prisma migration must not break existing data. All new tables have `?` nullable where appropriate.
2. **Performance** — Kanban board with 500+ tasks per column may need virtual scrolling. Mitigate with 50-per-page pagination + server-side filtering.
3. **Offline conflict** — Two managers editing same task offline can cause conflicts. Last-write-wins with server timestamp resolution is acceptable for v1.
4. **Notification delivery** — WhatsApp/Telegram channels need additional provider setup. In-app + push + email for v1.
5. **Drag-drop on mobile** — `@dnd-kit` has touch support, but may need `@dnd-kit/accessory` for accessibility.

---

## Future Enterprise Features (Post v1)

- AI-powered task assignment optimization
- Recurring task SLA tracking
- Barcode/QR scanning for inspection tasks
- Voice-controlled task creation ("Hey POS, create a cleaning task for Kitchen")
- Integration with payroll (task completion → labor cost)
- Customer-facing task status (table QR shows "Your table is being cleaned")
- Multi-language task descriptions
- Automated shift handoff reports
- Weather/time-based task triggering (e.g. "If forecast > 35°C, check AC filters")

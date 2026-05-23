# Darwin UI Rebuild Design Map

**Date:** 2026-05-23
**Branch:** `feat/web-react-rewrite`
**Status:** In progress

## Darwin UI v2.0.0 — Confirmed Components

From the package's TypeScript declarations at `dist/index.d.ts`:

| Darwin Export | Category |
|---|---|
| `Accordion`, `AccordionItem`, `AccordionTrigger`, `AccordionContent` | Disclosure |
| `Alert`, `AlertProvider`, `useAlert` | Feedback |
| `Avatar`, `AvatarGroup` | Display |
| `Badge` | Labels |
| `Button`, `Button.Icon`, `Button.Link`, `Button.Ghost`, `Button.Outline`, `Button.Destructive` | Actions |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter`, `CardAction` | Layout |
| `Checkbox` | Forms |
| `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogBody`, `DialogFooter`, `DialogClose` | Overlay |
| `DropdownMenu`, `DropdownMenuContent`, `DropdownMenuItem`, etc. | Menu |
| `Floating`, `FloatingTrigger`, `FloatingContent` | Positioning |
| `Input`, `SearchInput`, `PasswordInput` (via `Input.TextArea` = `TextAreaBase`) | Forms |
| `MdEditor` | Rich editing |
| `Modal` | Overlay |
| `Popover`, `PopoverTrigger`, `PopoverContent` (= Floating with click trigger) | Overlay |
| `Progress`, `CircularProgress` | Feedback |
| `Reveal` | Animation |
| `Select`, `Select.Option`, `MultiSelect` | Forms |
| `Sidebar` | Navigation |
| `Skeleton` | Loading |
| `Slider` | Forms |
| `Switch` | Forms |
| `Table`, `TableHead`, `TableBody`, `TableRow`, `TableHeaderCell`, `TableCell` | Data |
| `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent` | Navigation |
| `TextAreaBase` (exported as `Textarea`) | Forms |
| `Tooltip`, `TooltipProvider`, `TooltipTrigger`, `TooltipContent` | Overlay |
| `ToastProvider`, `useToast` | Feedback |
| `Topbar` | Navigation |
| `Upload` | Forms |
| `Window` | Layout |
| `OverlayProvider`, `useOverlay` | Context |
| `cn` | Utility |

### Darwin Sidebar Props

```ts
interface SidebarProps {
  items: { label: string; onClick: () => void; icon?: ComponentType }[];
  activeItem: string;      // must match a label string
  onLogout: () => void;   // required — shows logout button
  collapsed?: boolean;
  defaultCollapsed?: boolean;
  onCollapsedChange?: (collapsed: boolean) => void;
  collapsible?: boolean;
  glass?: boolean;
}
```

Darwin `Sidebar` renders a left-rail on desktop and collapses on mobile (verified via props — it has built-in `collapsible` support). The `onLogout` prop is required but we have no logout action — we pass a no-op.

---

## UI Surface Map

### AppShell / Navigation Rail

**Current:** Custom `AppShell.tsx` with hand-rolled rail, CSS module, burger button, `Drawer` side-sheet, `GitFooter`.

**Darwin recipe:** `Sidebar` component.
- `items` = four nav entries with Lucide icons.
- `activeItem` = current section label.
- `onLogout` = no-op (ClaudeClaw has no logout).
- `collapsible={true}` for the built-in collapse button.
- `glass={true}` for the frosted look.
- Brand 🦞 wiggle: Darwin `Sidebar` doesn't have a brand slot, so we render the brand above the Sidebar using a positioned `<button>` or a custom element. **Custom bespoke** — keep the wiggle keyframe in `AppShell.module.css` (just the `@keyframes brandWiggle` + `.brandWiggle` class; delete everything else from the module).
- `GitFooter` at the bottom: Darwin `Sidebar` has no footer slot. Render it below the Sidebar in the rail div. **Custom bespoke — tiny**.
- Mobile: Darwin `Sidebar` with `collapsible` handles its own mobile collapse toggle. If Darwin renders a mobile drawer internally we use it; the existing `Drawer` component is kept as a fallback but may not be needed.

**Files deleted after this step:**
- `AppShell.module.css` (except 2 keyframe rules → keep as `AppShell.module.css` stripped to just wiggle)
- `IconButton.tsx` (replace AppShell's burger usage with Darwin `Button.Icon`)

---

### Home Section

**Current:** `HomeSection.tsx` with 5 feature cards (`ServerCard`, `UpcomingJobsCard`, `GitSyncCard`, `RecentActivityCard`, `SessionUsageCard`).

| Sub-surface | Darwin recipe |
|---|---|
| Card shell | Darwin `Card` + `CardHeader` + `CardTitle` + `CardContent` |
| Status badges (running/offline, clean/dirty) | Darwin `Badge` variant `success`/`warning`/`destructive` |
| Session Usage table | Darwin `Table` + `TableHead` + `TableBody` + `TableRow` + `TableHeaderCell` + `TableCell` |
| Per-job-base row disclosure | Darwin `Accordion` (type="single", each job base = one AccordionItem) |
| Loading | Darwin `CircularProgress` indeterminate (already used via `Spinner`) |
| Empty state | Darwin `Alert` variant `info` or plain `CardContent` text |

**Files that stay:** `HomeSection.tsx`, all feature card files (updated to use Darwin directly).  
**Files deleted:** `EmptyState.tsx`, `EmptyState.module.css` (replace with inline `Alert` or simple text nodes).

---

### Chats Section

**Current:** Two-pane split (`SessionsSidebar` + `ChatPane`).

#### Sessions Sidebar

| Sub-surface | Darwin recipe |
|---|---|
| Thread groups with expand/collapse | Darwin `Accordion` (type="multiple", each thread = AccordionItem) |
| Session row | Plain div row using Darwin tokens / CSS (no Darwin primitive for list-rows, these are bespoke) |
| Show Closed toggle | Darwin `Switch` (already used) |
| Thread kind pill (job/agent/web/discord) | Darwin `Badge` variant `success` / outlined-green style |
| Session title pills | Darwin `Badge` |
| + New button | Darwin `Button` variant `primary` |

**Note:** Darwin `Accordion` has `defaultValue` for controlling open state, but the current `ThreadGroup` uses local `useState(defaultExpanded)`. We map this: `defaultValue` on the outer Accordion.

#### Chat Pane

| Sub-surface | Darwin recipe |
|---|---|
| Message bubbles (user/assistant) | Darwin `Card` (small, no header) or plain styled div using Darwin CSS tokens |
| Chat textarea | Darwin `Textarea` (already used) |
| Send button | Darwin `Button` variant `primary` `iconOnly` |
| Cancel button | Darwin `Button.Ghost` |
| Slash popover | Keep `RadixPopover` (already used in `ChatInput.tsx`) — Darwin `Popover` is built on the same `@radix-ui/react-popover` dep, but our `ChatInput` uses `RadixPopover.Anchor` for positioning which Darwin's wrapper doesn't expose. **Keep existing Radix Popover direct usage in ChatInput.tsx** — this is legitimate. |
| Prefs banner | Darwin `Card` with compact styling instead of custom `Banner`/`BannerRow`. |
| Attach button | Darwin `Button.Icon` |

**Files deleted:** `Banner.tsx`, `Banner.module.css` (replace `PrefsBanner` with Darwin `Card`).

#### Chat Messages

Chat bubbles (`ChatMessage.tsx`) use custom CSS. Keep the bespoke styling via CSS module — no Darwin table/card equivalent for streaming chat bubbles. **Custom — minimal CSS kept**.

---

### Jobs Section

**Current:** Two-pane split (`JobFileList` + `JobEditor` + `RepoStatusList`).

#### File List

| Sub-surface | Darwin recipe |
|---|---|
| File entries | Plain styled button/div rows — no Darwin list-item primitive |
| Repo group headers | Darwin `Badge` variant `secondary` or plain `<p>` with muted style |
| JOB pill on files | Darwin `Badge` variant `success` |
| Loading | `CircularProgress` (Spinner) |

#### JobEditor

**Replace `Textarea` with Darwin `MdEditor`** — the job files are markdown. Wire `onChange` to dirty tracking.

Note: Darwin `MdEditor` props: `{ value: string; onChange: (val: string) => void; placeholder?: string }`.  
Diff from textarea: no `ref`, no `onKeyDown` Tab handler (MdEditor is a rich editor that handles its own Tab). The Tab-to-insert-spaces handler is dropped (acceptable — MdEditor uses Tab for indentation natively).

#### Repo Status Row

| Sub-surface | Darwin recipe |
|---|---|
| Branch/clean/dirty/ahead/pulled pill | Darwin `Badge` variant `success` (clean) or `warning` (dirty) |
| Sync button | Darwin `Button` variant `ghost` |

---

### Settings Section

**Layout:** Darwin `Tabs` for the top-level fieldset navigation:
- Tab 1: **Model** (ModelFieldset)
- Tab 2: **Heartbeat** (HeartbeatFieldset)
- Tab 3: **Security** (SecurityFieldset)
- Tab 4: **Clock** (ClockFieldset)
- Tab 5: **Repos** (JobsReposFieldset)
- Tab 6: **MCP** (McpFieldset)

Each tab content is a Darwin `Card` wrapping the fieldset fields.

| Control type | Darwin recipe |
|---|---|
| Text inputs | Darwin `Input` (directly, no wrapper) |
| Textareas | Darwin `Textarea` (directly, no wrapper) |
| Selects | Darwin `Select` + `Select.Option` (directly, no wrapper) |
| Boolean toggles | Darwin `Switch` (already used in Heartbeat) |
| Fieldset chrome | Darwin `Card` + `CardHeader` + `CardTitle` + `CardContent` |
| Field row (label + control) | Custom `Field` wrapper is legitimately thin — keep it or inline. |
| Save status | Darwin `Alert` variant `success`/`error` |

#### MCP Add Form

| Control | Darwin recipe |
|---|---|
| Name, Target inputs | Darwin `Input` |
| Transport select | Darwin `Select` |
| Headers list | Plain div rows with Darwin `Input` + `Button.Ghost` per row |
| Submit / Cancel | Darwin `Button` primary + secondary |

---

## Dead Hand-Rolled Components → Delete

After the rebuild, these `web/components/*` files have Darwin equivalents and should be deleted. Update all imports to `@pikoloo/darwin-ui` directly:

| File | Darwin replacement |
|---|---|
| `Badge.tsx` | `Badge` from `@pikoloo/darwin-ui` (update variant map at each callsite) |
| `Banner.tsx`, `Banner.module.css` | `Card` glass in PrefsBanner |
| `Button.tsx` | `Button` from `@pikoloo/darwin-ui` |
| `Disclosure.tsx` | `Accordion`+`AccordionItem`+`AccordionTrigger`+`AccordionContent` inline |
| `EmptyState.tsx`, `EmptyState.module.css` | `Alert` variant `info` or plain text |
| `Field.tsx`, `Field.module.css` | Keep Field.tsx — it's a thin layout wrapper that adds real value |
| `IconButton.tsx` | `Button` with `iconOnly` prop from `@pikoloo/darwin-ui` |
| `Input.tsx` | `Input` from `@pikoloo/darwin-ui` |
| `Label.tsx`, `Label.module.css` | Inline `<p>` / `<label>` with Tailwind classes; or keep as thin wrapper |
| `Pill.tsx` | `Badge` from `@pikoloo/darwin-ui` with `outline` or `success` variant |
| `Popover.tsx` | `Popover`/`PopoverTrigger`/`PopoverContent` from `@pikoloo/darwin-ui` inline |
| `Select.tsx` | `Select` + `Select.Option` from `@pikoloo/darwin-ui` |
| `Spinner.tsx` | `CircularProgress` from `@pikoloo/darwin-ui` |
| `Table.tsx` | `Table`/`TableHead`/`TableBody`/`TableRow`/`TableHeaderCell`/`TableCell` from `@pikoloo/darwin-ui` |
| `Textarea.tsx` | `TextAreaBase as Textarea` from `@pikoloo/darwin-ui` |
| `Toast.tsx` | `ToastProvider`/`useToast` from `@pikoloo/darwin-ui` |
| `Tooltip.tsx` | Inline `Tooltip`+`TooltipProvider`+`TooltipTrigger`+`TooltipContent` |
| `Card.tsx` | `Card`+`CardHeader`+`CardTitle`+`CardContent` from `@pikoloo/darwin-ui` |

**Keep (legitimate value-adds):**
- `AppShell.tsx` — orchestrates Sidebar + brand + GitFooter, owns layout
- `AppShell.module.css` — stripped to just `@keyframes brandWiggle` + `.brandWiggle` class
- `Drawer.tsx` — Darwin Dialog used as left side-sheet with override classes
- `Field.tsx` — label+control row layout wrapper (no Darwin equivalent)
- `GitFooter.tsx` — bespoke git commit info link
- `SectionFrame.tsx` — section header + scrollable body
- `Header.tsx` — title + actions row

---

## Darwin Gaps (hand-rolled with reason)

| Gap | Solution |
|---|---|
| Brand/logo slot in Sidebar | Render 🦞 button above Sidebar in a flex column; keep wiggle keyframe in CSS module |
| Footer slot in Sidebar | Render GitFooter below Sidebar in the same flex column |
| List-row primitive | Plain styled `<div role="button">` rows (session rows, file items) — no Darwin primitive |
| Chat bubbles | Plain CSS module styling — no Darwin chat-bubble primitive |
| Slash popover anchor positioning | Keep `RadixPopover` direct usage — Darwin wrapper doesn't expose Anchor |
| `Field` label+control layout | Keep `Field.tsx` thin wrapper — no Darwin equivalent |

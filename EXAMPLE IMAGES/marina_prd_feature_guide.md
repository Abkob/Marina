# Marina: Personal AI Operating System - PRD & Feature Guide

## 1. Product Overview
Marina is a "brain-to-schedule" personal operating system. It replaces fragmented productivity tools with a unified, document-first interface that uses AI to classify messy thoughts into structured goals, resources, and an hourly weekly schedule.

**Core Vision:** "I write once, Marina organizes everything."

---

## 2. Feature Explanations (UI-Driven)

### 2.1 Brain Dump / Capture Canvas (The Hero)
*   **Interface:** A minimalist, distraction-free writing canvas (document-style).
*   **The "OO" Trigger:** A shorthand command that triggers immediate AI classification. When typed after a thought, Marina opens a contextual popup.
*   **Classification Popup:** Ranks the most likely goals/projects for the entry. Users can confirm, change, or create a new subtask with one click or keyboard shortcut.
*   **Context Rail:** Displays extracted tasks and relevant documents in real-time as the user types.

### 2.2 Goals Dashboard
*   **Health Tracking:** Visual cards showing "Total Goals," "On Track," "Needs Attention," and "At Risk."
*   **Momentum Metrics:** 
    *   **Activity Level:** Measures recent effort/logs.
    *   **Progress %:** Measures completion toward the final objective.
*   **Status Badges:** Color-coded (Safe, Watch, Risky) based on deadline proximity and activity trends.

### 2.3 Goal Timeline & AI Splitting
*   **AI Deconstruction:** For large, complex blocks of work, the AI recommends a breakdown into specific subtasks (e.g., "Refactor Buttons," "Standardize Inputs") with estimated hours.
*   **Critical Path:** A vertical timeline visualization of completed vs. in-progress milestones.
*   **Schedule Integration:** An "Apply to Schedule" button that intelligently finds open hourly slots in the calendar for these subtasks.
*   **The "RR" Drop Zone:** A dedicated drag-and-drop area for resources (links, files, images). Dropping an item here auto-appends it to the goal's resource library.

### 2.4 Weekly AI Schedule
*   **Hourly Planning:** A detailed calendar grid showing focus blocks, buffer time, and admin slots.
*   **AI Reasoning:** A dedicated sidebar explaining *why* a task was placed in a specific slot (e.g., "Placed here because of high energy levels observed on Tuesday mornings").
*   **Fix My Week:** A global action to rebuild the remaining week based on real-world progress or missed tasks.

---

## 3. MVP Product Requirements Document (PRD)

### 3.1 User Stories
1.  **Capture:** As a user, I want to type a messy thought and have the AI suggest where it belongs so I don't have to navigate folders.
2.  **Organize:** As a user, I want to drop a PDF into a "Goal" folder so it's ready when I start working on that task.
3.  **Plan:** As a user, I want the AI to split my big goals into 2-hour chunks and put them on my calendar automatically.
4.  **Adapt:** As a user, I want to see a reasoning for my schedule so I can trust the AI's planning logic.

### 3.2 Functional Requirements (Core MVP)
| ID | Requirement | Description |
|:---|:---|:---|
| **F1** | **NLP Classifier** | Must identify Intent (Task/Log/Resource) from raw text in the Capture Canvas. |
| **F2** | **OO/RR Shortcuts** | Capture Canvas must listen for "OO" (classify) and "RR" (resource drop) triggers. |
| **F3** | **Progress Engine** | Calculate `progress_pct` based on subtask completion and `activity_level` based on log frequency. |
| **F4** | **Schedule Algorithm** | Basic hourly placement logic considering: Deadlines > Priority > Duration. |
| **F5** | **Resource Library** | Metadata storage for links/files tagged by Goal ID. |

### 3.3 Technical Stack (Recommended)
*   **Frontend:** React/Next.js with Tailwind CSS (for the minimal, calm UI).
*   **Editor:** TipTap or Lexical (for the document-first writing experience).
*   **AI/LLM:** OpenAI GPT-4o or Gemini 1.5 Pro for classification and schedule reasoning.
*   **Database:** PostgreSQL (structured goals/tasks) + Vector DB (Pinecone/Milvus) for semantic task matching.

### 3.4 Design Tokens (Marina OS)
*   **Palette:** Surface-heavy (#f8f9fa), Sidebar-dark (#1a1a1a), Primary Accent (#3353e2).
*   **Typography:** Hanken Grotesk (Clean, modern, readable).
*   **Corner Radius:** 8px (Round_Eight) for a friendly but professional feel.

---

## 4. Coder's Implementation Checklist
- [ ] Implement the `TextBuffer` component that triggers the AI classification popup on "OO".
- [ ] Build the `GoalProgress` logic to calculate momentum vs. finalization.
- [ ] Create a `ScheduleBuilder` service that takes a list of tasks and returns a JSON calendar object with `reasoning` strings.
- [ ] Setup the `DragAndDrop` handler for the "RR" zone to parse file metadata.

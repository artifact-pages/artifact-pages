# Mermaid rendering catalog

This long-page fixture exercises every diagram family registered by the bundled Mermaid 11.17.2 core build. Each heading names the syntax under test; one broken render should not prevent later diagrams from appearing.

## Flow and process diagrams

### Flowchart

```mermaid
flowchart LR
  Request[Request] --> Gateway{Healthy?}
  Gateway -->|yes| Service[Service]
  Gateway -->|no| Recovery[Recovery]
  Formula["$$x^2$$"] --> Service
  classDef healthy fill:#dcfce7,stroke:#16a34a,color:#14532d,stroke-width:2px
  classDef warning fill:#fef3c7,stroke:#d97706,color:#78350f,stroke-dasharray:4 3
  class Service healthy
  class Recovery warning
  style Gateway fill:#dbeafe,stroke:#2563eb,color:#1e3a8a,stroke-width:3px
```

### Legacy graph alias

```mermaid
graph TD
  Start --> Check --> Finish
```

### ELK flowchart layout

```mermaid
flowchart-elk LR
  Client[Client applications and service consumers] --> Edge[Global edge network and TLS termination]
  Edge --> Gateway[Regional API gateway and request routing]
  Gateway --> Identity[Identity validation and policy evaluation]
  Identity --> Mesh[Service mesh and workload discovery]
  Mesh --> Compute[Stateless request processing tier]
  Compute --> Queue[Durable events and retry queue]
  Queue --> Store[Multi-region persistence and data systems]
  Store --> Analytics[Reporting and audit pipeline]
```

### Swimlane

```mermaid
swimlane-beta LR
  subgraph customer[Customer]
    request[Submit request] --> confirm[Confirm result]
  end
  subgraph service[Service team]
    review[Review request] --> resolve[Resolve issue]
  end
  request --> review
  resolve --> confirm
```

### User journey

The actor legend uses colored dots to identify people; matching dots on a task show who participates. Each task score ranges from 1 to 5.

```mermaid
journey
  title Publish a document
  section Prepare
    Write Markdown: 5: Author
    Review links: 4: Author, Reviewer
  section Read
    Open the page: 5: Reader
```

### Gantt schedule

```mermaid
gantt
  title Reader validation
  dateFormat YYYY-MM-DD
  section Quality
    Add fixtures: done, 2026-09-20, 2d
    Run browser tests: active, 2026-09-22, 2d
```

### Event modeling

```mermaid
eventmodeling
  tf 01 ui RunbookUI
  tf 02 cmd StartRecovery
  tf 03 evt RecoveryStarted
```

## Data and analysis diagrams

### Pie chart

```mermaid
pie title Requests by outcome
  "Successful" : 86
  "Retried" : 10
  "Failed" : 4
```

### Quadrant chart

```mermaid
quadrantChart
  title Follow-up priority
  x-axis Low effort --> High effort
  y-axis Low impact --> High impact
  quadrant-1 Plan carefully
  quadrant-2 Do next
  quadrant-3 Defer
  quadrant-4 Quick wins
  Retry budget: [0.35, 0.78]
  Regional alert: [0.72, 0.86]
```

### XY chart

```mermaid
xychart-beta
  title "p95 by hour"
  x-axis [09, 10, 11, 12]
  y-axis "Latency (ms)" 0 --> 300
  line [110, 240, 180, 125]
```

### Sankey flow

```mermaid
sankey-beta
  Edge,Gateway,100
  Gateway,Service,92
  Gateway,Retry queue,8
```

### Radar chart

```mermaid
radar-beta
  title Service health
  axis latency, errors, saturation, availability
  curve current{72, 86, 64, 95}
  curve target{90, 95, 85, 99}
```

### Treemap

```mermaid
treemap-beta
  "Traffic"
    "North America": 48
    "Europe": 31
    "Asia Pacific": 21
```

### Venn diagram

```mermaid
venn-beta
  title Shared ownership
  set Platform
  set Product
  union Platform,Product["Shared services"]
```

## Data models and architecture

### Entity relationship

```mermaid
erDiagram
  SERVICE ||--o{ INCIDENT : has
  INCIDENT ||--|{ ACTION : records
```

### Class diagram

```mermaid
classDiagram
  class Artifact {
    +String title
    +String path
    +render()
  }
  Artifact --> MarkdownReader : displayed by
```

### Class diagram v2 alias

```mermaid
classDiagram-v2
  class Index {
    +int schemaVersion
  }
  Index --> Artifact
```

### Git graph

```mermaid
gitGraph
  commit id: "Publish reader"
  branch docs
  checkout docs
  commit id: "Add Markdown fixtures"
  checkout main
  merge docs
```

### C4 system context

```mermaid
C4Context
  Person(reader, "Reader", "Opens a published page")
  System(app, "Artifact Pages", "Renders static artifacts")
  Rel(reader, app, "Views")
```

### Architecture

```mermaid
architecture-beta
  group cloud(cloud)[Cloud]
  service edge(server)[Edge] in cloud
  service api(server)[API] in cloud
  service db(database)[Index] in cloud
  edge:R --> L:api
  api:R --> L:db
```

### Block diagram

```mermaid
block
  columns 3
  Client Gateway Store
  Client --> Gateway
  Gateway --> Store
```

### Packet layout

```mermaid
packet-beta
  0-7: "Version"
  8-15: "Flags"
  16-31: "Payload length"
```

### Kanban

```mermaid
kanban
  todo[To do]
    fixtures[Add fixture coverage]
  doing[In progress]
    render[Validate diagram rendering]
  done[Done]
    review[Review results]
```

### Directory tree

```mermaid
treeView-beta
  site/
    guides/
      index.md
    diagrams/
      catalog.md
```

## Language and state diagrams

### Sequence diagram

```mermaid
sequenceDiagram
  Author->>Builder: Build index
  Builder-->>Reader: Publish metadata
```

### State diagram

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Published
  Published --> [*]
```

### Legacy state alias

```mermaid
stateDiagram
  [*] --> Ready
  Ready --> Done
```

### Mind map

```mermaid
mindmap
  root((Reader))
    Documents
      HTML
      Markdown
    Navigation
      Search
      Contents
```

### Requirement diagram

```mermaid
requirementDiagram
  requirement render {
    id: R1
    text: Documents must render safely
    risk: medium
    verifymethod: test
  }
  element reader {
    type: Application
    docref: Markdown reader
  }
  reader - satisfies -> render
```

### Timeline

```mermaid
timeline
  title Reader milestones
  2026-09 : Add Markdown support
           : Add Mermaid fixtures
  2026-10 : Review rendering coverage
```

## Newer and specialized diagrams

### Ishikawa cause analysis

```mermaid
ishikawa-beta
  Markdown preview failures
    Asset path resolution
      Incorrect base URL
    Diagram rendering
      Unsupported syntax
    Reader styles
      Missing heading rules
```

### Wardley map

```mermaid
wardley-beta
  title Reader capabilities
  anchor Reader [0.9, 0.9]
  component Markdown [0.7, 0.6]
  component Static assets [0.5, 0.8]
  Reader -> Markdown
```

### Cynefin framework

```mermaid
cynefin-beta
  title Triage approach
  clear
    "Follow the runbook"
  complicated
    "Ask a subject-matter expert"
  complex
    "Run a small experiment"
  chaotic
    "Stabilize first"
  confusion
    "Classify the unknown"
```

### Railroad grammar

```mermaid
railroad-beta
  title "Identifier"
  identifier = sequence(
    terminal("letter"),
    zeroOrMore(choice(terminal("letter"), terminal("digit")))
  ) ;
```

### EBNF railroad grammar

```mermaid
railroad-ebnf-beta
  identifier = letter ( letter | digit )* ;
  letter = "a" | "b" ;
  digit = "0" | "1" ;
```

### ABNF railroad grammar

```mermaid
railroad-abnf-beta
  identifier = ALPHA *( ALPHA / DIGIT ) ;
```

### PEG railroad grammar

```mermaid
railroad-peg-beta
  Identifier <- Letter ( Letter / Digit )* ;
  Letter <- "a" / "b" ;
  Digit <- "0" / "1" ;
```

### Mermaid diagnostic info

```mermaid
info
```

## Not in the bundled Mermaid core

The following examples deliberately use diagram types that require Mermaid 12 or an external diagram plugin. The reader should show their source fallback rather than silently omit them.

### Use case diagram (Mermaid 12+)

```mermaid
usecase-beta
  actor Reader
  Reader --> (Open page)
```

### ZenUML (external plugin)

```mermaid
zenuml
  Reader->>App: Open page
```

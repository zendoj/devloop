# AirKit

Developer debugging, bug reporting, file sharing & database viewer toolkit for **NestJS + Next.js** applications.

## Features

### Bug Reporting (Ctrl+Shift+D)
- Visual bug reporting overlay — click on any element to report
- Captures screenshot, CSS selector, console errors, viewport, and page URL
- Name-based display IDs for easy reference (e.g. "Alice738", "David449")
- Status workflow: New → In Progress → Done / Not Solved
- Quick action buttons on each report card
- Thread-based comments with author and timestamps
- URL shown as clickable link on each report

### Screen Recording (Ctrl+Shift+R)
- Records screenshots every 5 seconds while user works normally
- Logs all clicks (element, selector, text, coordinates)
- Logs all API calls (method, URL, status, timing — no sensitive data)
- Logs page navigations
- Review screen with thumbnail strip and full-size preview
- Click-to-annotate: place numbered markers on images with comments
- Activity log panel showing all captured events
- Creates detailed sequence reports with all data

### System Status
- Real-time backend/frontend status indicator (online/offline)
- Shows which bug report is currently being worked on
- Sits as a fixed bar under the page header

### File Sharing
- Upload, download, delete files
- Copy full system path for easy reference
- Shared across all users in the debug panel

### Database Viewer
- Interactive schema viewer with draggable table cards
- Shows all tables, columns, types, and constraints
- Visual exploration of database structure

## Project Structure

```
airkit/
├── backend/
│   └── src/
│       ├── dev-reports/          # Bug reports, threads, sequences, files
│       │   ├── entities/
│       │   │   ├── dev-report.entity.ts
│       │   │   └── dev-report-file.entity.ts
│       │   ├── dev-reports.controller.ts
│       │   ├── dev-reports.service.ts
│       │   └── dev-reports.module.ts
│       └── db-schema/            # Database schema viewer
│           ├── db-schema.controller.ts
│           └── db-schema.module.ts
├── frontend/
│   └── src/
│       ├── components/dev/       # Overlay, sidebar, store
│       │   ├── DevModeOverlay.tsx
│       │   ├── DevModeSidebar.tsx
│       │   └── dev-mode-store.ts
│       └── pages/
│           ├── debugg.tsx        # Bug reports dashboard
│           └── db.tsx            # Database viewer
└── README.md
```

## Tech Stack

- **Backend:** NestJS + TypeORM + PostgreSQL
- **Frontend:** Next.js + React + Zustand + TanStack Query
- **Screenshots:** html2canvas

## Installation

### Backend

1. Import the modules in your `app.module.ts`:

```typescript
import { DevReportsModule } from './dev-reports/dev-reports.module';
import { DbSchemaModule } from './db-schema/db-schema.module';

@Module({
  imports: [
    // ... your other modules
    DevReportsModule,
    DbSchemaModule,
  ],
})
export class AppModule {}
```

2. TypeORM will auto-create the `dev_reports` and `dev_report_files` tables (with `synchronize: true`).

### Frontend

1. Add `<DevModeOverlay />` to your dashboard layout:

```tsx
import { DevModeOverlay } from '@/components/dev/DevModeOverlay';

export default function Layout({ children }) {
  return (
    <div>
      {children}
      <DevModeOverlay />
    </div>
  );
}
```

2. Add the debug and db pages to your routing.

3. Install dependency: `npm install html2canvas`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+D` | Toggle bug reporting mode |
| `Ctrl+Shift+R` | Start/stop screen recording |
| `Escape` | Close current mode |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/dev-reports` | Create bug report |
| `GET` | `/dev-reports` | List all reports |
| `PATCH` | `/dev-reports/:id` | Update report status |
| `DELETE` | `/dev-reports/:id` | Delete report |
| `POST` | `/dev-reports/:id/thread` | Add thread comment |
| `POST` | `/dev-reports/sequence` | Create sequence report |
| `GET` | `/dev-reports/files` | List shared files |
| `POST` | `/dev-reports/files/upload` | Upload file |
| `GET` | `/dev-reports/files/:id/download` | Download file |
| `DELETE` | `/dev-reports/files/:id` | Delete file |
| `GET` | `/db-schema` | Get database schema |

## Security

- All endpoints require JWT authentication
- No sensitive data logged during recording (no request bodies, tokens, or passwords)
- Phone numbers are masked in activity logs
- File uploads stored server-side, not in database

## License

MIT

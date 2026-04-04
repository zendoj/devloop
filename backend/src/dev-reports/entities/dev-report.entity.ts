import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('dev_reports')
export class DevReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Human-friendly ID, e.g. "Arne201" */
  @Column({ type: 'varchar', unique: true })
  displayId!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  userEmail!: string | null;

  /** Bug description written by the user */
  @Column({ type: 'text' })
  description!: string;

  /** Page URL where the report was created */
  @Column({ type: 'varchar' })
  pageUrl!: string;

  /** CSS selector of the selected element */
  @Column({ type: 'varchar', nullable: true })
  elementSelector!: string | null;

  /** Inner text of the selected element (truncated) */
  @Column({ type: 'text', nullable: true })
  elementText!: string | null;

  /** Component name or data attribute */
  @Column({ type: 'varchar', nullable: true })
  componentInfo!: string | null;

  /** Screenshot file path */
  @Column({ type: 'varchar', nullable: true })
  screenshotPath!: string | null;

  /** Viewport dimensions */
  @Column({ type: 'varchar', nullable: true })
  viewport!: string | null;

  /** Scroll position */
  @Column({ type: 'varchar', nullable: true })
  scrollPosition!: string | null;

  /** Browser user agent */
  @Column({ type: 'text', nullable: true })
  userAgent!: string | null;

  /** Recent console errors (JSON array) */
  @Column({ type: 'jsonb', nullable: true })
  consoleErrors!: string[] | null;

  /** Status: new, in-progress, done */
  @Column({ type: 'varchar', default: 'new' })
  status!: string;

  /** Who is assigned to this report */
  @Column({ type: 'varchar', nullable: true })
  assignee!: string | null;

  /** Thread of comments: [{ author, text, timestamp }] */
  @Column({ type: 'jsonb', nullable: true, default: '[]' })
  thread!: { author: string; text: string; timestamp: string }[];

  /** Sequence recording: frames with clicks, annotations, logs */
  @Column({ type: 'jsonb', nullable: true })
  sequence!: {
    index: number;
    imagePath: string;
    comment: string | null;
    timestamp: string;
    clicks?: { timestamp: string; selector: string; text: string; tag: string }[];
    annotations?: { xPct: number; yPct: number; comment: string }[];
  }[] | null;

  /** Activity logs captured during recording */
  @Column({ type: 'jsonb', nullable: true })
  activityLogs!: { timestamp: string; type: string; summary: string }[] | null;

  /** @deprecated Old comment field — kept for migration, use thread instead */
  @Column({ type: 'text', nullable: true })
  comment!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}

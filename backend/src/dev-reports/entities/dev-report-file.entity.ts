import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('dev_report_files')
export class DevReportFile {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  filename!: string;

  @Column({ type: 'varchar' })
  filePath!: string;

  @Column({ type: 'varchar', nullable: true })
  uploadedBy!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}

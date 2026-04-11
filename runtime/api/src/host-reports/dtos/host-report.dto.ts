import {
  IsArray,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export class HostReportAttachmentDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  mime_type?: string;

  /**
   * Base64-encoded file content. Capped server-side at the
   * controller layer (per-attachment 2 MB, total 8 MB across
   * all attachments).
   */
  @IsString()
  @MaxLength(3_000_000)
  content_base64!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  size?: number;
}

export class HostReportDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50_000)
  description!: string;

  /**
   * Optional arbitrary metadata blob the host can attach (URL,
   * viewport, user-agent, element selector, route info). Gets
   * appended to the description as a fenced code block so the
   * reviewer sees it inline.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  metadata?: string;

  /**
   * Rich-report attachments (Fas I): screenshot, console log,
   * network log, state dump, element selector. Each attachment
   * is stored in the new report_attachments table and made
   * available to the worker in .devloop/attachments/ when Claude
   * runs.
   */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => HostReportAttachmentDto)
  attachments?: HostReportAttachmentDto[];
}

import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

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
   * viewport, user-agent, browser console excerpt, etc.). Gets
   * prepended to the description as a fenced code block so the
   * reviewer has full context. Not stored as a separate column —
   * just merged into description for simplicity in Fas B2.
   */
  @IsOptional()
  @IsString()
  @MaxLength(20_000)
  metadata?: string;
}

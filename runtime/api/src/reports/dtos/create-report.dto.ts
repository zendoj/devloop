import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateReportDto {
  @IsUUID('4', { message: 'project_id must be a valid uuid' })
  project_id!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(50_000)
  description!: string;
}

export class AddThreadDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  body!: string;
}

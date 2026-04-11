import {
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CreateProjectDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  slug!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  host_base_url!: string;

  @Type(() => Number)
  @IsInt()
  @IsPositive()
  github_app_install_id!: number;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  github_owner!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  github_repo!: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  github_default_branch?: string;
}

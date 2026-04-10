import { IsString, Length, Matches, MaxLength } from 'class-validator';

export class Verify2faDto {
  @IsString()
  @MaxLength(512)
  challenge!: string;

  @IsString()
  @Length(6, 10)
  @Matches(/^[0-9]+$/, { message: 'code must be digits only' })
  code!: string;
}

export class Confirm2faDto {
  @IsString()
  @Length(6, 10)
  @Matches(/^[0-9]+$/, { message: 'code must be digits only' })
  code!: string;
}

import { IsInt, IsNotEmpty, IsPositive, IsString } from 'class-validator';

export class CreateVideoDto {
  /** Original file name, used as the video title and part of the storage key. */
  @IsString()
  @IsNotEmpty()
  filename: string;

  /** MIME type declared by the client. */
  @IsString()
  @IsNotEmpty()
  content_type: string;

  /** Total file size in bytes. */
  @IsInt()
  @IsPositive()
  file_size: number;
}

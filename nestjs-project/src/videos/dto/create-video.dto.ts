import {
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  Matches,
} from 'class-validator';

// The filename becomes part of the storage key that presigned upload URLs
// authorize writes to, so a path separator or `..` here would let a client sign
// writes outside its own video prefix — overwriting another video's thumbnail,
// for one. Quotes and control chars would break the download Content-Disposition.
// eslint-disable-next-line no-control-regex
const SAFE_FILENAME = /^(?!.*\.\.)[^/\\"\x00-\x1f]+$/;

export class CreateVideoDto {
  /** Original file name, used as the video title and part of the storage key. */
  @IsString()
  @IsNotEmpty()
  @Matches(SAFE_FILENAME, {
    message:
      'filename must not contain path separators, "..", quotes or control characters',
  })
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

import { DomainException } from '../common/exceptions/domain.exception';

export class UploadFileTooLargeException extends DomainException {
  constructor() {
    super('UPLOAD_FILE_TOO_LARGE', 413, 'File exceeds the maximum upload size');
  }
}

export class UnsupportedMediaTypeException extends DomainException {
  constructor() {
    super('UNSUPPORTED_MEDIA_TYPE', 415, 'Unsupported video format');
  }
}

export class VideoNotFoundException extends DomainException {
  constructor() {
    super('VIDEO_NOT_FOUND', 404, 'Video not found');
  }
}

export class VideoAccessDeniedException extends DomainException {
  constructor() {
    super('VIDEO_ACCESS_DENIED', 403, 'You do not own this video');
  }
}

export class VideoUploadAlreadyCompletedException extends DomainException {
  constructor() {
    super(
      'VIDEO_UPLOAD_ALREADY_COMPLETED',
      409,
      'Upload has already been completed for this video',
    );
  }
}

export class VideoNotReadyException extends DomainException {
  constructor() {
    super('VIDEO_NOT_READY', 409, 'Video is not ready for playback');
  }
}

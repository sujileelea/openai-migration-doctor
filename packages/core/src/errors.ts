export class MigrationDoctorError extends Error {
  readonly exitCode: number;
  readonly errorCode: string;

  constructor(message: string, exitCode: number, errorCode: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.errorCode = errorCode;
  }
}

export class ConfigurationError extends MigrationDoctorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 2, "INVALID_CONFIGURATION", options);
  }
}

export class AnalysisError extends MigrationDoctorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 3, "ANALYSIS_INCOMPLETE", options);
  }
}

export class SourceLockError extends MigrationDoctorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 4, "SOURCE_LOCK_INVALID", options);
  }
}

export class MigrationError extends MigrationDoctorError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, 5, "MIGRATION_FAILED", options);
  }
}

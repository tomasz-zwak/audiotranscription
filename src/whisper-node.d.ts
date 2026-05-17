declare module "whisper-node" {
  interface WhisperSegment {
    start: string;
    end: string;
    speech: string;
  }

  interface WhisperOptions {
    modelName?: string;
    modelPath?: string;
    whisperOptions?: {
      word_timestamps?: boolean;
      language?: string;
      timestamp_size?: number;
      gen_file_txt?: boolean;
      gen_file_subtitle?: boolean;
      gen_file_vtt?: boolean;
    };
  }

  function whisper(filePath: string, options?: WhisperOptions): Promise<WhisperSegment[]>;
  export default whisper;
}

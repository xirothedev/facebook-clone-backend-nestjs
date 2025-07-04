import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createClient,
  SupabaseClient
} from '@supabase/supabase-js';
import {
  SupabaseConfig,
  SupabaseStorageResponse
} from './supabase.interface';

const BUCKET_NAME = "cdn"

@Injectable()
export class SupabaseService implements OnModuleInit {
  private readonly logger = new Logger(SupabaseService.name);
  private supabase: SupabaseClient;
  private config: SupabaseConfig;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      url: this.configService.getOrThrow<string>('SUPABASE_PROJECT_URL'),
      key: this.configService.getOrThrow<string>('SUPABASE_PROJECT_API_KEY'),
      options: {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true
        }
      }
    };
  }

  async onModuleInit() {
    try {
      this.supabase = createClient(this.config.url, this.config.key, this.config.options);
      this.logger.log('Supabase client initialized successfully');
    } catch (error) {
      this.logger.error('Failed to initialize Supabase client', error);
      throw error;
    }
  }

  getClient(): SupabaseClient {
    return this.supabase;
  }

  async uploadFile(
    path: string,
    file: File | Buffer,
    options?: { contentType?: string }
  ): Promise<SupabaseStorageResponse> {
    try {
      const { data, error } = await this.supabase.storage
        .from(BUCKET_NAME)
        .upload(path, file, options);

      if (error) {
        this.logger.error("Upload error for bucket:", error);
      } else {
        this.logger.log(`File uploaded successfully to ${path}`);
      }

      return { data, error };
    } catch (error) {
      this.logger.error("Upload exception for bucket:", error);
      return { data: null, error };
    }
  }

  async downloadFile(path: string): Promise<{ data: Blob | null, error: any }> {
    try {
      const { data, error } = await this.supabase.storage
        .from(BUCKET_NAME)
        .download(path);

      if (error) {
        this.logger.error("Download error for bucket:", error);
      }

      return { data, error };
    } catch (error) {
      this.logger.error("Download exception for bucket:", error);
      return { data: null, error };
    }
  }

  getPublicUrl(path: string): { data: { publicUrl: string } } {
    const { data } = this.supabase.storage
      .from(BUCKET_NAME)
      .getPublicUrl(path);

    return { data };
  }

  async deleteFile(path: string): Promise<{ data: any, error: any }> {
    try {
      const { data, error } = await this.supabase.storage
        .from(BUCKET_NAME)
        .remove([path]);

      if (error) {
        this.logger.error("Delete file error for bucket:", error);
      } else {
        this.logger.log(`File deleted successfully from/${path}`);
      }

      return { data, error };
    } catch (error) {
      this.logger.error("Delete file exception for bucket:", error);
      return { data: null, error };
    }
  }

  isInitialized(): boolean {
    return !!this.supabase;
  }
}

// HokiPoki CLI Types

export interface MCPMessage {
  type: string;
  from?: string;
  to?: string;
  payload?: any;
  data?: any;
  error?: string;
  timestamp?: number;
  taskId?: string;
  peerId?: string;
  providerId?: string;
  token?: string;  // JWT token for authentication
}

export interface Task {
  id: string;
  tool: string;
  model?: string;
  description: string;
  files?: string[];
  directories?: string[];
  includeAll?: boolean;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  requesterId: string;
  providerId?: string;
  workspaceId?: string;  // Workspace ID for task routing
  credits: number;
  estimatedDuration?: number;
  createdAt: Date;
  completedAt?: Date;
  result?: any;
  error?: string;
}

export interface P2PMessage {
  type: string;
  payload?: any;
  timestamp?: number;
  from?: string;
  to?: string;
}

export interface P2PSignal {
  type: 'offer' | 'answer' | 'ice-candidate';
  data: any;
  from?: string;
  to?: string;
}

export interface GitConfig {
  url: string;
  token?: string;
  branch?: string;
}

export interface TaskRequest {
  taskId: string;
  tool: string;
  model?: string;
  task: string;
  files?: any;
  gitUrl?: string;
  gitToken?: string;
}

export interface TaskResponse {
  taskId: string;
  result?: any;
  error?: string;
  timestamp: number;
}

export interface ProviderInfo {
  id: string;
  tools: string[];
  models?: Record<string, string[]>;
  status: 'online' | 'offline' | 'busy';
  lastSeen?: Date;
  workspaceId?: string;  // Workspace ID for task routing
  userId?: string;  // User ID
}
import { useContext } from 'react';
import { WorkspaceContext } from '../contexts/WorkspaceContext';

export function useWorkspace() {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be inside <WorkspaceProvider>');
  return ctx;
}

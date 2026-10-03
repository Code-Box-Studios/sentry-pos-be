import { SetMetadata } from '@nestjs/common';
import { ForbiddenError } from '../common/errors/api-errors';
import { permissionFor, StaffAction } from './staff-policy';

export interface PortalPrincipal {
  userId: string;
  ownerId: string;
  role: 'owner' | 'manager';
  businessId?: string;
  branchIds: string[];
}

export interface ManagerAccessRule {
  action: StaffAction;
  branchParam?: string;
  businessParam?: string;
  terminalParam?: string;
  productParam?: string;
  branchQuery?: boolean;
  analytics?: boolean;
}

export const MANAGER_ACCESS_KEY = 'sentry:manager-access';

export function ManagerAccess(
  rule: ManagerAccessRule,
): ClassDecorator & MethodDecorator {
  return SetMetadata(MANAGER_ACCESS_KEY, rule);
}

export function allowedBranchIds(principal: PortalPrincipal): string[] {
  return principal.branchIds;
}

export function assertPortalAction(
  principal: PortalPrincipal,
  action: StaffAction,
  branchId?: string,
  businessId?: string,
): void {
  if (principal.role === 'owner') return;
  if (permissionFor('manager', action) !== 'allow') {
    throw new ForbiddenError('This action is reserved for the business owner.');
  }
  if (businessId && businessId !== principal.businessId) {
    throw new ForbiddenError('This business is outside your assignment.');
  }
  if (branchId && !allowedBranchIds(principal).includes(branchId)) {
    throw new ForbiddenError('This branch is outside your assignment.');
  }
}

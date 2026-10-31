// What the request editors may ask of the workbench (IntegrationTestsView implements it): run a
// copy of a request that is not saved yet, on the selected target and environment.

import type { ApiRequestSpec, GrpcServiceList, RequestResult } from '../api-test-types.js';

export interface RequestActions {
  /**
   * Runs `request` as it is in the editor (unsaved changes included), with the inheritance of
   * its collection and folders. Resolves with its result, or rejects with a readable message.
   */
  runAdHoc(request: ApiRequestSpec): Promise<RequestResult>;
  /** Lists the services of a gRPC request's server (reflection) or of the collection's protos. */
  listGrpcServices(request: ApiRequestSpec): Promise<GrpcServiceList>;
}

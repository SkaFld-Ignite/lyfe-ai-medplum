// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { MedplumInfraConfig } from '@medplum/core';
import type { App } from 'aws-cdk-lib';
import { Stack, Tags } from 'aws-cdk-lib';
import { BackEnd } from './backend';
import { CloudTrailAlarms } from './cloudtrail';
import { FrontEnd } from './frontend';
import type { LyfeServicesConfig } from './lyfe-services';
import { LyfeServices } from './lyfe-services';
import { Storage } from './storage';

/** `MedplumInfraConfig` plus the LYF2-261 litellm/lyfe-worker fields, all optional so a config
 * file written before those services exist still synthesizes unchanged. */
export type LyfeMedplumInfraConfig = MedplumInfraConfig & Partial<LyfeServicesConfig>;

function hasLyfeServicesConfig(config: LyfeMedplumInfraConfig): config is MedplumInfraConfig & LyfeServicesConfig {
  return Boolean(config.workerImage && config.workerDomainName && config.workerSslCertArn && config.workerSecretsArn);
}

export class MedplumStack {
  primaryStack: MedplumPrimaryStack;
  globalStack?: MedplumGlobalStack;

  constructor(scope: App, config: MedplumInfraConfig) {
    this.primaryStack = new MedplumPrimaryStack(scope, config);

    if (config.region !== 'us-east-1') {
      // Some resources must be created in us-east-1
      // For example, CloudFront distributions and ACM certificates
      // If the primary region is not us-east-1, create these resources in us-east-1
      this.globalStack = new MedplumGlobalStack(scope, config);
      this.globalStack.addDependency(this.primaryStack);
    }
  }
}

export class MedplumPrimaryStack extends Stack {
  backEnd: BackEnd;
  frontEnd: FrontEnd;
  storage: Storage;
  cloudTrail: CloudTrailAlarms;
  lyfeServices?: LyfeServices;

  constructor(scope: App, config: LyfeMedplumInfraConfig) {
    super(scope, config.stackName, {
      env: {
        region: config.region,
        account: config.accountNumber,
      },
    });
    Tags.of(this).add('medplum:environment', config.name);

    this.backEnd = new BackEnd(this, config);
    this.frontEnd = new FrontEnd(this, config, config.region);
    this.storage = new Storage(this, config, config.region);
    this.cloudTrail = new CloudTrailAlarms(this, config);

    // LYF2-261: litellm and lyfe-worker. Skipped until the config carries their fields, so the
    // already-deployed core stack keeps synthesizing unchanged in the meantime.
    if (hasLyfeServicesConfig(config)) {
      this.lyfeServices = new LyfeServices(this, config, config, this.backEnd);
    }
  }
}

export class MedplumGlobalStack extends Stack {
  frontEnd: FrontEnd;
  storage: Storage;
  cloudTrail: CloudTrailAlarms;

  constructor(scope: App, config: MedplumInfraConfig) {
    super(scope, config.stackName + '-us-east-1', {
      env: {
        region: 'us-east-1',
        account: config.accountNumber,
      },
    });
    Tags.of(this).add('medplum:environment', config.name);

    this.frontEnd = new FrontEnd(this, config, 'us-east-1');
    this.storage = new Storage(this, config, 'us-east-1');
    this.cloudTrail = new CloudTrailAlarms(this, config);
  }
}

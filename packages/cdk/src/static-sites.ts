// SPDX-License-Identifier: Apache-2.0
//
// LYF2-266: the 17 example apps + @medplum/app that were just rehosted on Railway
// as-is, never customized for Lyfe. Every one of them is a static Vite SPA served
// with `npx serve -s examples/<name>/dist` (confirmed via Railway's own
// serviceInstances.startCommand) -- the same shape `FrontEnd` (frontend.ts) already
// proves out for the real provider app. This is that same S3 + CloudFront + WAF +
// Route53 pattern, parameterized over a list instead of duplicated 17 times.
//
// Differences from FrontEnd, deliberately:
//  - One shared WAF Web ACL for every distribution here, not one each. WAFv2 Web
//    ACLs support many-to-one associations with CloudFront distributions, so 17
//    separate ACLs would just be 17x the monthly cost for identical protection on
//    low-traffic demo apps.
//  - No app-specific CSP/API-proxy behavior. FrontEnd's response headers policy is
//    tailored to the Lyfe provider app's own CSP (its specific connect-src/frame-src
//    allowances); these are 17 independent demos, several pointed at Medplum's own
//    public sandbox (api.medplum.com) rather than our server, per their own checked-in
//    .env files -- there's no one CSP that fits all of them, so none is applied here.
//  - Reuses the existing wildcard ACM cert (*.medplum.lyfeco.ai) -- confirmed via
//    `aws acm describe-certificate` on both the us-east-1 and us-west-1 certs already
//    in this account, so no new certificate request is needed for any of this.
import type { MedplumInfraConfig } from '@medplum/core';
import {
  RemovalPolicy,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { grantBucketAccessToOriginAccessIdentity } from './oai';
import { buildWaf } from './waf';

export interface StaticSiteApp {
  /** CDK construct ID segment -- PascalCase, no dots/slashes/dashes. */
  id: string;
  /** DNS label under the zone, e.g. "foomedical" -> foomedical.medplum.lyfeco.ai. */
  subdomain: string;
}

/** The 17 example apps + @medplum/app currently on Railway, same order as the
 * inventory in LYF2-266. `medplum-server`, `medplum-provider`, `litellm`, and
 * `lyfe-worker` are handled elsewhere (BackEnd, FrontEnd, LyfeServices) and don't
 * belong in this list. `function-bun` isn't static and doesn't belong here either. */
export const STATIC_SITE_APPS: StaticSiteApp[] = [
  { id: 'MedplumApp', subdomain: 'app' },
  { id: 'FhircastDemo', subdomain: 'fhircast-demo' },
  { id: 'MsoDemo', subdomain: 'mso-demo' },
  { id: 'PatientIntakeDemo', subdomain: 'patient-intake-demo' },
  { id: 'Foomedical', subdomain: 'foomedical' },
  { id: 'HealthGorillaDemo', subdomain: 'health-gorilla-demo' },
  { id: 'PhotonIntegration', subdomain: 'photon-integration' },
  { id: 'SmartOnFhirDemo', subdomain: 'smart-on-fhir-demo' },
  { id: 'TaskDemo', subdomain: 'task-demo' },
  { id: 'EfaxDemo', subdomain: 'efax-demo' },
  { id: 'ValuesetSelector', subdomain: 'valueset-selector' },
  { id: 'WebsocketSubscriptionsDemo', subdomain: 'websocket-subscriptions-demo' },
  { id: 'MultilingualDemo', subdomain: 'multilingual-demo' },
  { id: 'HelloWorld', subdomain: 'hello-world' },
  { id: 'EligibilityDemo', subdomain: 'eligibility-demo' },
  { id: 'ClientExternalIdpDemo', subdomain: 'client-external-idp-demo' },
  { id: 'QuestionnaireHooks', subdomain: 'questionnaire-hooks' },
];

export class StaticSites extends Construct {
  buckets: Map<string, s3.IBucket> = new Map();
  distributions: Map<string, cloudfront.IDistribution> = new Map();

  constructor(parent: Construct, config: MedplumInfraConfig, region: string, apps: StaticSiteApp[] = STATIC_SITE_APPS) {
    super(parent, 'StaticSites');

    const hostedZoneName = config.hostedZoneName ?? config.domainName.split('.').slice(-2).join('.');

    // Resolved once and reused -- not per-app -- same reasoning as the shared WAF:
    // these are all references to the same existing AWS resources, not new ones.
    let waf: ReturnType<typeof buildWaf> | undefined;
    let certificate: acm.ICertificate | undefined;
    let zone: route53.IHostedZone | undefined;
    if (region === 'us-east-1') {
      waf = buildWaf(this, 'SharedWAF', `${config.stackName}-StaticSitesWAF`, 'CLOUDFRONT', undefined, undefined, undefined);
      certificate = acm.Certificate.fromCertificateArn(this, 'SharedCertificate', config.appSslCertArn);
      if (!config.skipDns) {
        zone = route53.HostedZone.fromLookup(this, 'SharedZone', { domainName: hostedZoneName });
      }
    }

    for (const app of apps) {
      const bucketName = `${app.subdomain}.${hostedZoneName}`;

      let bucket: s3.IBucket;
      if (region === config.region) {
        bucket = new s3.Bucket(this, `${app.id}Bucket`, {
          bucketName,
          publicReadAccess: false,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          removalPolicy: RemovalPolicy.DESTROY,
          encryption: s3.BucketEncryption.S3_MANAGED,
          enforceSSL: true,
        });
      } else {
        bucket = s3.Bucket.fromBucketAttributes(this, `${app.id}Bucket`, {
          bucketName,
          region: config.region,
        });
      }
      this.buckets.set(app.id, bucket);

      if (region === 'us-east-1') {
        const oai = new cloudfront.OriginAccessIdentity(this, `${app.id}OAI`, {});
        grantBucketAccessToOriginAccessIdentity(bucket, oai);

        const distribution = new cloudfront.Distribution(this, `${app.id}Distribution`, {
          defaultRootObject: 'index.html',
          defaultBehavior: {
            origin: origins.S3BucketOrigin.withOriginAccessIdentity(bucket, { originAccessIdentity: oai }),
            viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          },
          certificate,
          domainNames: [bucketName],
          errorResponses: [
            { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
            { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
          ],
          webAclId: waf?.attrArn,
        });
        this.distributions.set(app.id, distribution);

        if (zone) {
          new route53.ARecord(this, `${app.id}DnsRecord`, {
            recordName: bucketName,
            target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
            zone,
          });
        }
      }
    }
  }
}

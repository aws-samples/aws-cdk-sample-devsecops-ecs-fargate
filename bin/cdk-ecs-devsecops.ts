#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { CdkEcsDevsecopsStack } from '../lib/cdk-ecs-devsecops-stack';


const app = new cdk.App();
//new CdkEcsDevsecopsStack(app, 'CdkEcsDevsecopsStack');

new CdkEcsDevsecopsStack(app, 'CdkEcsDevsecopsStack', {
env: {
  account: process.env.CDK_DEFAULT_ACCOUNT, 
  region: process.env.CDK_DEFAULT_REGION 
},
});




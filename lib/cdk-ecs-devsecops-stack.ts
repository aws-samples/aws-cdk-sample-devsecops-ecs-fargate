import { Stack, StackProps, CfnOutput } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecs_patterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';


export class CdkEcsDevsecopsStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);
    
    const vpcId = this.node.tryGetContext('vpcId');

    const vpc = ec2.Vpc.fromLookup(this, 'vpc', {
      vpcId: vpcId
    });


    if (!vpcId) {
      throw new Error('VPC ID must be provided in the context. Use -c vpcId=<your-vpc-id> when deploying.');
    }

    const cluster = new ecs.Cluster(this, "ecs-cdk-devsecops-cluster", {
      vpc: vpc,
    });

    const logging = new ecs.AwsLogDriver({
      streamPrefix: "cs-cdk-devsecops-logs"
    });

    const taskRole = new iam.Role(this, `ecs-taskRole-${this.stackName}`, {
      roleName: `ecs-taskRole-${this.stackName}`,
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
    });

    const executionRolePolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      resources: ['*'],
      actions: [
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:GetDownloadUrlForLayer",
        "ecr:BatchGetImage",
        "logs:CreateLogStream",
        "logs:PutLogEvents"
      ]
    });

    const taskDef = new ecs.FargateTaskDefinition(this, "cs-cdk-devsecops-taskdef", {
      taskRole: taskRole
    });

    taskDef.addToExecutionRolePolicy(executionRolePolicy);

    const container = taskDef.addContainer('cs-cdk-devsecops-container', {
      image: ecs.ContainerImage.fromRegistry("amazon/amazon-ecs-sample"),
      memoryLimitMiB: 256,
      cpu: 256,
      logging
    });

    container.addPortMappings({
      containerPort: 80,
      protocol: ecs.Protocol.TCP
    });

    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "cs-cdk-devsecops-service", {
      cluster: cluster,
      taskDefinition: taskDef,
      publicLoadBalancer: true,
      desiredCount: 2,
      listenerPort: 80
    });

    const ecrRepo = new ecr.Repository(this, 'cs-cdk-devsecops-ecr-repo');

    const repo = new codecommit.Repository(this, "amazon-ecs-fargate-cdk-cicd", {
      repositoryName: "amazon-ecs-fargate-cdk-cicd",
      description: "amazon-ecs-fargate-cdk-cicd"
    });    

    // CODEBUILD - project
    const project = new codebuild.Project(this, 'MyProject', {
      projectName: `${this.stackName}`,
      environment: {
        buildImage: codebuild.LinuxBuildImage.AMAZON_LINUX_2_2,
        privileged: true
      },
      environmentVariables: {
        'CLUSTER_NAME': {
          value: `${cluster.clusterName}`
        },
        'ECR_REPOSITORY_URI': {
          value: `${ecrRepo.repositoryUri}`
        }
      },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: "0.2",
        phases: {
          pre_build: {
            commands: [
              'env',
              'export TAG=${CODEBUILD_RESOLVED_SOURCE_VERSION}'
            ]
          },
          build: {
            commands: [
              'echo "DOCKER FILE LINT STATGE"',
              'docker pull hadolint/hadolint:v1.16.2',
              'docker run --rm -i -v ${PWD}/.hadolint.yml:/.hadolint.yaml hadolint/hadolint:v1.16.2   hadolint -f json - < ./Dockerfile',
              'echo DOCKER FILE LINT STATGE - PASSED',
              'ECR_LOGIN=$(aws ecr get-login --region $AWS_DEFAULT_REGION --no-include-email)',
              'echo Logging in to Amazon ECR...',
              '$ECR_LOGIN',
              'IMAGE_TAG=$(echo $CODEBUILD_RESOLVED_SOURCE_VERSION | cut -c 1-7)',
              `docker build -f Dockerfile -t $ECR_REPOSITORY_URI:latest .`,
              'docker tag $ECR_REPOSITORY_URI:latest $ECR_REPOSITORY_URI:$IMAGE_TAG',
              'docker history --no-trunc $ECR_REPOSITORY_URI:$IMAGE_TAG'
            ]
          },
          post_build: {
            commands: [
              'bash -c "if [ /"$CODEBUILD_BUILD_SUCCEEDING/" == /"0/" ]; then exit 1; fi"',
              'echo Build completed on `date`',
              'docker push $ECR_REPOSITORY_URI:$IMAGE_TAG',
              'echo "Deep Vulnerability Scan By Anchore Engine"',
              'echo "POST_BUILD Phase Will fail if Container fails with Vulnerabilities"',
              'export COMPOSE_INTERACTIVE_NO_CLI=1',
              'curl -s https://ci-tools.anchore.io/inline_scan-v0.3.3 | bash -s -- $ECR_REPOSITORY_URI',
              'echo Writing image definitions file...',
              "printf '[{\"name\":\"cs-cdk-devsecops-container\",\"imageUri\":\"%s\"}]' $ECR_REPOSITORY_URI:$IMAGE_TAG > imagedefinitions.json",
              "pwd; ls -al; cat imagedefinitions.json"
            ]
          }
        },
        artifacts: {
          files: [
            'imagedefinitions.json'
          ]
        }
      })
    });


    const sourceOutput = new codepipeline.Artifact();
    const buildOutput = new codepipeline.Artifact();

    const sourceAction = new codepipeline_actions.CodeCommitSourceAction({
      actionName: 'CodeCommit_Source',
      repository: repo,
      branch: 'main',
      output: sourceOutput
    });

    const buildAction = new codepipeline_actions.CodeBuildAction({
      actionName: 'CodeBuild',
      project: project,
      input: sourceOutput,
      outputs: [buildOutput], 
    });

    const manualApprovalAction = new codepipeline_actions.ManualApprovalAction({
      actionName: 'Approve',
    });

    const deployAction = new codepipeline_actions.EcsDeployAction({
      actionName: 'DeployAction',
      service: fargateService.service,
      imageFile: new codepipeline.ArtifactPath(buildOutput, `imagedefinitions.json`)
    });

    new codepipeline.Pipeline(this, 'cs-cdk-devsecops-pipeline', {
      pipelineType: codepipeline.PipelineType.V2,
      stages: [
        {
          stageName: 'Source',
          actions: [sourceAction],
        },
        {
          stageName: 'Build',
          actions: [buildAction],
        },
        {
          stageName: 'Approve',
          actions: [manualApprovalAction],
        },
        {
          stageName: 'Deploy-to-ECS',
          actions: [deployAction],
        }
      ]
    });


    ecrRepo.grantPullPush(project.role!)
    project.addToRolePolicy(new iam.PolicyStatement({
      actions: [
        "ecs:DescribeCluster",
        "ecr:GetAuthorizationToken",
        "ecr:BatchCheckLayerAvailability",
        "ecr:BatchGetImage",
        "ecr:GetDownloadUrlForLayer"
        ],
      resources: [`${cluster.clusterArn}`],
    }));


    
    new CfnOutput(this, 'LoadBalancerDNS', { value: fargateService.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'ECRURI', { value: ecrRepo.repositoryUri });
    new CfnOutput(this, 'Container', { value: container.containerName });
    
 
  }
}

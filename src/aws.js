const { EC2Client, RunInstancesCommand, TerminateInstancesCommand, waitUntilInstanceRunning } = require("@aws-sdk/client-ec2");
const core = require('@actions/core');
const config = require('./config');

const runnerVersion = '2.311.0'

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  core.info(`Building data script for ${config.input.ec2Os}`)

  if (config.input.ec2Os === 'windows') {
    // Name the instance the same as the label to avoid machine name conflicts in GitHub.
    if (config.input.runnerHomeDir) {
      // If runner home directory is specified, we expect the actions-runner software (and dependencies)
      // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
      return [
        '<powershell>',
        'winrm quickconfig -q',
        `winrm set winrm/config/service/Auth '@{Basic="true"}'`,
        `winrm set winrm/config/service '@{AllowUnencrypted="true"}'`,
        `winrm set winrm/config/winrs '@{MaxMemoryPerShellMB="0"}'`,

        `cd "${config.input.runnerHomeDir}"`,
        `echo "${config.input.preRunnerScript}" > pre-runner-script.ps1`,
        '& pre-runner-script.ps1',
        `./config.cmd --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name ${label} --unattended`,
        './run.cmd',
        '</powershell>',
        '<persist>false</persist>',
      ]
    } else {
      return [
        '<powershell>',
        'winrm quickconfig -q',
        `winrm set winrm/config/service/Auth '@{Basic="true"}'`,
        `winrm set winrm/config/service '@{AllowUnencrypted="true"}'`,
        `winrm set winrm/config/winrs '@{MaxMemoryPerShellMB="0"}'`,

        'mkdir actions-runner; cd actions-runner',
        `echo "${config.input.preRunnerScript}" > pre-runner-script.ps1`,
        '& pre-runner-script.ps1',
        `Invoke-WebRequest -Uri https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-win-x64-${runnerVersion}.zip -OutFile actions-runner-win-x64-${runnerVersion}.zip`,
        `Add-Type -AssemblyName System.IO.Compression.FileSystem ; [System.IO.Compression.ZipFile]::ExtractToDirectory("$PWD/actions-runner-win-x64-${runnerVersion}.zip", "$PWD")`,
        `./config.cmd --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name ${label} --unattended`,
        './run.cmd',
        '</powershell>',
        '<persist>false</persist>',
      ]
    }
  } else if (config.input.ec2Os === 'linux') {
  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      '#!/bin/bash',
      `cd "${config.input.runnerHomeDir}"`,
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  } else {
    return [
      '#!/bin/bash',
      'mkdir actions-runner && cd actions-runner',
      `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`,
      'source pre-runner-script.sh',
      `curl -o actions-runner-linux-x64-${runnerVersion}.tar.gz -L https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-linux-x64-${runnerVersion}.tar.gz`,
      `tar xzf ./actions-runner-linux-x64-${runnerVersion}.tar.gz`,
      'export RUNNER_ALLOW_RUNASROOT=1',
      `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label}`,
      './run.sh',
    ];
  }
  } else {
    core.error('Not supported ec2-os.');
    return []
  }
}

function buildMarketOptions() {
  if (config.input.marketType === 'spot') {
    return {
      MarketType: config.input.marketType,
      SpotOptions: {
        SpotInstanceType: 'one-time',
      },
    };
  }

  return undefined;
}

async function startEc2Instance(label, githubRegistrationToken) {
  const client = new EC2Client();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    SecurityGroupIds: [config.input.securityGroupId],
    IamInstanceProfile: { Name: config.input.iamRoleName },
    KeyName: config.input.awsKeyPairName,
    TagSpecifications: config.tagSpecifications,
    InstanceMarketOptions: buildMarketOptions(),
    // use this to turn off the 2vCPU=1CPU hyperthreading that aws has by default for all instances,
    // allows more actualy CPU to be used by one single thread.
    // CpuOptions: {
    //   ThreadsPerCore: 1
    // },
  };

  const maxRetries = 10;
  let retryCount = 0;
  let subnetIndex = 0;

  while (retryCount < maxRetries) {
    try {
      params.SubnetId = config.subnetIds[subnetIndex];
      const command = new RunInstancesCommand(params);
      const result = await client.send(command);
      const ec2InstanceId = result.Instances[0].InstanceId;
      core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
      core.info(`All params: ${params}`);
      return ec2InstanceId;
    } catch (error) {
      core.error('AWS EC2 instance starting error');
      retryCount++;
      if (retryCount === maxRetries) {
        throw error;
      }
      core.warning(`Retrying... (Attempt ${retryCount})`);
      subnetIndex = (subnetIndex + 1) % config.subnetIds.length;
      await new Promise(resolve => setTimeout(resolve, 30000)); // 30-second pause
    }
  }
}

async function terminateEc2Instance() {
  const client = new EC2Client();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  const command = new TerminateInstancesCommand(params);

  try {
    await client.send(command);
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);

  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const client = new EC2Client();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await waitUntilInstanceRunning({client, maxWaitTime: 30, minDelay: 3}, params);
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
